// ====================================
// 🚀 SERVIDOR LICITACIONES - OPCIÓN 2
// Copiar este código directamente en server.js
// ====================================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// ============== CONFIGURACIÓN ==============
const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const MAX_FILE_SIZE = (process.env.MAX_FILE_SIZE_MB || 80) * 1024 * 1024;
const TEMP_DIR = process.env.TEMP_DIR || './uploads';

// Validar configuración
if (!N8N_WEBHOOK_URL) {
  console.error('❌ ERROR: N8N_WEBHOOK_URL no configurada en .env');
  process.exit(1);
}

// Crear directorio
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log(`📁 Directorio creado: ${TEMP_DIR}`);
}

// ============== MULTER STORAGE ==============
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const sanitized = file.originalname
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/_+/g, '_');
    cb(null, `${timestamp}-${random}-${sanitized}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Solo PDFs permitidos'), false);
    }
    cb(null, true);
  }
});

// ============== MIDDLEWARE ==============
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============== RUTAS ==============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    n8nConnected: !!N8N_WEBHOOK_URL
  });
});

// Estadísticas
app.get('/stats', (req, res) => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const stats = {
      filesWaiting: files.length,
      tempDir: TEMP_DIR,
      maxFileSize: `${process.env.MAX_FILE_SIZE_MB || 80}MB`,
      n8nWebhook: N8N_WEBHOOK_URL.substring(0, 50) + '...',
      environment: process.env.NODE_ENV || 'development'
    };

    if (files.length > 0) {
      const totalSize = files.reduce((sum, file) => {
        try {
          const stat = fs.statSync(path.join(TEMP_DIR, file));
          return sum + stat.size;
        } catch (e) {
          return sum;
        }
      }, 0);
      stats.totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
    } else {
      stats.totalSizeMB = '0';
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPLOAD - Ruta principal
// ============== RUTA BATCH - VERSIÓN CORREGIDA ==============
app.post('/api/upload-batch', upload.array('files', 10), async (req, res) => {
  const startTime = Date.now();
  const filePaths = [];

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files found'
      });
    }

    const batchId = req.body.batch_id || `batch_${Date.now()}`;
    const processType = req.body.process_type || 'GG';
    const clientId = req.body.client_id || 'INTELEC_SL';
    const totalFiles = req.files.length;

    console.log(`\n📦 BATCH RECIBIDO - ${totalFiles} archivos`);
    req.files.forEach((file, i) => {
      console.log(`  ${i + 1}. ${file.originalname}`);
      filePaths.push(file.path);
    });

    // Preparar FormData para n8n
    const formData = new FormData();

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileStream = fs.createReadStream(file.path);
      
      formData.append(`file_${i + 1}`, fileStream, {
        filename: file.originalname,
        contentType: 'application/pdf'
      });
    }

    // Metadata
    formData.append('batch_id', batchId);
    formData.append('process_type', processType);
    formData.append('client_id', clientId);
    formData.append('total_files', totalFiles);
    formData.append('uploaded_by', 'backend-api-batch');
    formData.append('upload_timestamp', new Date().toISOString());

    console.log(`🚀 Enviando batch a N8N...`);

    // Enviar a n8n
    const response = await axios.post(N8N_WEBHOOK_URL, formData, {
      headers: formData.getHeaders(),
      timeout: 600000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Respuesta: ${response.status} (${processingTime}s)`);

    // Limpiar archivos
    filePaths.forEach(filePath => {
      fs.unlink(filePath, () => {});
    });

    if (response.status >= 200 && response.status < 300) {
      return res.json({
        success: true,
        message: `✅ ${totalFiles} archivo(s) enviado(s) a N8N en batch`,
        batchId: batchId,
        totalFiles: totalFiles,
        processingTime: `${processingTime}s`,
        n8nResponse: response.data
      });
    } else {
      return res.status(response.status).json({
        success: false,
        error: 'Error en N8N',
        details: response.data
      });
    }

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    
    filePaths.forEach(filePath => {
      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, () => {});
      }
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============== LIMPIEZA AUTOMÁTICA ==============
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000;

  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > maxAge) {
          fs.unlink(filePath, () => console.log(`🗑️ Limpiado: ${file}`));
        }
      });
    });
  });
}, 30 * 60 * 1000);

// ============== ERROR HANDLING ==============
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({
        success: false,
        error: 'File too large',
        maxSize: `${process.env.MAX_FILE_SIZE_MB || 80}MB`
      });
    }
  }
  res.status(500).json({ success: false, error: err.message });
});

// ============== INICIAR ==============
app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════╗');
  console.log('║ 🚀 LICITACIONES API - OPCIÓN 2 ║');
  console.log('╚═══════════════════════════════╝\n');
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`📤 Upload: http://localhost:${PORT}/api/upload`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
  console.log(`\n✅ Servidor listo\n`);
});
