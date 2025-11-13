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
app.post('/api/upload-batch', upload.array('file'), async (req, res) => {
  let filePath = null;
  const startTime = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file found'
      });
    }

    filePath = req.file.path;
    const fileSize = req.file.size;
    const fileName = req.file.originalname;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    console.log(`\n📄 ARCHIVO RECIBIDO: ${fileName} (${fileSizeMB}MB)`);

    // Preparar FormData para n8n
    const fileStream = fs.createReadStream(filePath);
    const formData = new FormData();
    
    formData.append('file', fileStream, {
      filename: fileName,
      contentType: 'application/pdf'
    });
    formData.append('process_type', req.body.process_type || 'GG');
    formData.append('client_id', req.body.client_id || 'INTELEC_SL');
    formData.append('uploaded_by', 'backend-api');
    formData.append('file_size_mb', fileSizeMB);

    console.log(`🚀 Enviando a n8n...`);

    // Enviar a n8n
    const response = await axios.post(N8N_WEBHOOK_URL, formData, {
      headers: formData.getHeaders(),
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Respuesta de n8n: ${response.status} (${processingTime}s)`);

    // Limpiar archivo
    fs.unlink(filePath, () => {});

    if (response.status >= 200 && response.status < 300) {
      return res.json({
        success: true,
        message: 'Archivo procesándose',
        fileName: fileName,
        fileSize: fileSize,
        fileSizeMB: fileSizeMB,
        processingTime: `${processingTime}s`,
        jobId: response.data?.jobId || `job_${Date.now()}`
      });
    } else {
      return res.status(response.status).json({
        success: false,
        error: 'N8N error',
        status: response.status
      });
    }

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);

    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }

    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check n8n is available and URL is correct'
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
