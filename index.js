require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { startBot, botState, processMessage, userSessions, sendBroadcast } = require('./bot.js');
const { getAllPromotions, addPromotion, updatePromotion, deletePromotion, getAnalyticsStats, getAllClients, addCampaign, getAllCampaigns, deleteCampaign, saveLog, getLogs, clearLogs, getAllQuotes, getQuoteDetailsById, deleteQuote, getActiveManual, getAllManuals, addManual, updateManualStatus, deleteManual } = require('./localDb.js');
const { startSyncTask, syncProducts } = require('./syncTask.js');
const { deleteSqlPedido } = require('./db.js');
const multer = require('multer');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'promos_imgs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const manualStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'manuals');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const uploadManual = multer({
    storage: manualStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos PDF'), false);
        }
    }
});

const app = express();
const PORT = process.env.QR_WEB_PORT || 80;

app.use(express.json());

const brandColor = '#9F1C87';

const getHtmlTemplate = (title, content, headScript = '') => `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | Lopez Impresores</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --brand-color: ${brandColor};
            --brand-hover: #7a1568;
            --bg-color: #f3f4f6;
            --card-bg: #ffffff;
            --text-main: #1f2937;
            --text-muted: #6b7280;
        }
        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-image: radial-gradient(circle at top right, #eaddf8, transparent 40%),
                              radial-gradient(circle at bottom left, #f3e8f8, transparent 40%);
        }
        .container {
            background-color: var(--card-bg);
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.05);
            text-align: center;
            max-width: 450px;
            width: 90%;
            border-top: 5px solid var(--brand-color);
        }
        h1 {
            color: var(--brand-color);
            font-weight: 800;
            margin-top: 0;
            font-size: 24px;
        }
        p {
            color: var(--text-muted);
            line-height: 1.5;
            margin-bottom: 20px;
        }
        .qr-wrapper {
            background: white;
            padding: 15px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            display: inline-block;
            margin: 15px 0;
            border: 1px solid #e5e7eb;
        }
        .qr-wrapper img {
            display: block;
            border-radius: 8px;
        }
        .status-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            background-color: #e5e7eb;
            color: var(--text-muted);
            margin-top: 15px;
        }
        .status-badge.active {
            background-color: #dcfce7;
            color: #166534;
        }
        .loader {
            border: 4px solid #f3f3f3;
            border-top: 4px solid var(--brand-color);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
    ${headScript}
</head>
<body>
    <div class="container">
        ${content}
    </div>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'hub.html'));
});

app.get('/connection', (req, res) => {
    if (botState.hasConnected) {
        const content = `
            <h1>✅ Bot Conectado</h1>
            <p>El bot de <strong>Lopez Impresores</strong> está activo y listo para cotizar.</p>
            <div class="status-badge active">
                Estado: ${botState.connected ? 'Conectado a WhatsApp' : 'Intentando reconectar...'}
            </div>
            <div style="margin-top: 30px; display: flex; gap: 10px; justify-content: center;">
                <a href="/" style="text-decoration: none; background: #6b7280; color: white; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 14px;">← Volver al Panel</a>
                <a href="/simulator" style="text-decoration: none; background: #25d366; color: white; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 14px;">Ir al Simulador</a>
            </div>
        `;
        const script = `
            <script>
                setInterval(async () => {
                    try {
                        const res = await fetch('/status');
                        const data = await res.json();
                        if (!data.hasConnected) window.location.reload();
                    } catch(e) {}
                }, 5000);
            </script>
        `;
        return res.send(getHtmlTemplate('Bot Activo', content, script));
    }

    if (!botState.qr) {
        const content = `
            <h1>⏳ Iniciando Motor...</h1>
            <p>Conectando con WhatsApp, por favor espera.</p>
            <div class="loader"></div>
            <p style="font-size: 13px;">La página se actualizará automáticamente.</p>
        `;
        const script = `<meta http-equiv="refresh" content="3">`;
        return res.send(getHtmlTemplate('Iniciando', content, script));
    }

    const content = `
        <h1>Lopez Impresores</h1>
        <p>Abre WhatsApp en tu teléfono, ve a <strong>Dispositivos vinculados</strong> y escanea este código para activar el bot.</p>
        
        <div class="qr-wrapper">
            <img id="qrimg" src="/qr?t=${Date.now()}" style="width:280px; height:280px;" alt="Código QR">
        </div>
        
        <br>
        <div class="status-badge">Esperando vinculación...</div>
        <div style="margin-top: 20px;">
            <a href="/" style="text-decoration: none; color: var(--brand-color); font-weight: 600;">← Volver al Panel</a>
        </div>
    `;

    const script = `
        <script>
            function refreshQR() {
                const img = document.getElementById('qrimg');
                if(img) img.src = '/qr?t=' + Date.now();
            }
            async function checkStatus() {
                try {
                    const res = await fetch('/status');
                    const data = await res.json();
                    if (data.hasConnected) window.location.replace('/connection');
                } catch(e) {}
            }
            window.addEventListener('load', () => {
                setInterval(refreshQR, 15000);
                setInterval(checkStatus, 2000);
            });
        </script>
    `;

    res.send(getHtmlTemplate('Escanear QR', content, script));
});

app.get('/status', (req, res) => {
    res.json({ connected: botState.connected, hasConnected: botState.hasConnected });
});

app.get('/qr', async (req, res) => {
    if (!botState.qr) return res.status(404).send('QR no disponible');
    try {
        const png = await QRCode.toBuffer(botState.qr, {
            color: {
                dark: brandColor,  // Usa el color del branding para los pixeles del QR
                light: '#ffffff'
            },
            width: 300
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(png);
    } catch (err) {
        res.status(500).send('Error al generar QR');
    }
});

// ─── Simulador: API de chat ───────────────────────────────────────────────────
// Usa un número ficticio fijo para no mezclar con clientes reales
const SIMULATOR_PHONE = 'simulator_preview';

// Resetear sesión del simulador (POST desde JS, GET desde navegador)
app.all('/chat/reset', (_req, res) => {
    if (userSessions[SIMULATOR_PHONE]) {
        delete userSessions[SIMULATOR_PHONE];
    }
    res.json({ ok: true, message: 'Sesión del simulador reiniciada.' });
});

app.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Campo "message" requerido.' });
    }

    try {
        const responses = await processMessage(SIMULATOR_PHONE, message, true);

        // Convertir respuestas al formato que entiende el frontend
        const output = responses.map(r => {
            if (r.type === 'pdf') {
                const fileName = path.basename(r.pdfPath);
                const isManual = r.pdfPath.includes('manuals');
                const folder = isManual ? 'manuals' : 'quotes_pdfs';
                return { type: 'pdf', text: r.text, url: `/${folder}/${fileName}` };
            }
            // Importante: incluir la URL para imágenes para que el simulador las muestre
            return { type: r.type, text: r.text, url: r.url };
        });

        res.json({ responses: output });
    } catch (err) {
        console.error('Error en /chat:', err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Servir PDFs generados para el simulador
app.use('/quotes_pdfs', express.static(path.join(__dirname, 'quotes_pdfs')));
app.use('/manuals', express.static(path.join(__dirname, 'manuals')));

// ─── Manual de Uso ──────────────────────────────────────────────────────────
app.get('/manual', (req, res) => {
    res.sendFile(path.join(__dirname, 'manual.html'));
});

app.get('/api/manuals', async (req, res) => {
    try {
        const manuals = await getAllManuals();
        res.json(manuals);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/manuals', uploadManual.single('manual'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'El archivo PDF es obligatorio.' });
        }
        const filename = req.file.originalname;
        const filepath = `manuals/${req.file.filename}`; // relative path
        const active = req.body.active === 'true' || req.body.active === '1' ? 1 : 0;

        await addManual(filename, filepath, active);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/manuals/:id', async (req, res) => {
    try {
        const { active } = req.body;
        await updateManualStatus(req.params.id, active);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/manuals/:id', async (req, res) => {
    try {
        const manual = await deleteManual(req.params.id);
        if (manual && manual.filepath) {
            const absolutePath = path.join(__dirname, manual.filepath);
            if (fs.existsSync(absolutePath)) {
                fs.unlinkSync(absolutePath);
            }
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Simulador: UI ────────────────────────────────────────────────────────────
app.get('/simulator', (_req, res) => {
    res.sendFile(path.join(__dirname, 'simulator.html'));
});

// ─── Dashboard de Promociones ────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API para promociones
app.get('/api/promotions', async (req, res) => {
    try {
        const promos = await getAllPromotions();
        res.json(promos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/promotions', upload.single('image'), async (req, res) => {
    try {
        const { text, position } = req.body;
        const image_url = req.file ? `/promos_imgs/${req.file.filename}` : '';
        await addPromotion(text, image_url, position);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use('/promos_imgs', express.static(path.join(__dirname, 'promos_imgs')));

app.patch('/api/promotions/:id', async (req, res) => {
    try {
        const { active } = req.body;
        await updatePromotion(req.params.id, active);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/promotions/:id', async (req, res) => {
    try {
        await deletePromotion(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Analítica ───────────────────────────────────────────────────────────────
app.get('/analytics', (req, res) => {
    res.sendFile(path.join(__dirname, 'analytics.html'));
});

app.get('/api/analytics', async (req, res) => {
    try {
        const stats = await getAnalyticsStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Campañas de Difusión ────────────────────────────────────────────────────
app.get('/campaigns', (req, res) => {
    res.sendFile(path.join(__dirname, 'campaigns.html'));
});

app.get('/api/campaigns', async (req, res) => {
    try {
        const campaigns = await getAllCampaigns();
        res.json(campaigns);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/campaigns', upload.single('image'), async (req, res) => {
    try {
        const { text } = req.body;
        const image_url = req.file ? `/promos_imgs/${req.file.filename}` : '';
        await addCampaign(text, image_url);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/campaigns/:id', async (req, res) => {
    try {
        await deleteCampaign(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/campaigns/:id/send', async (req, res) => {
    try {
        const campaigns = await getAllCampaigns();
        const campaign = campaigns.find(c => c.id == req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

        const clients = await getAllClients();
        if (clients.length === 0) return res.status(400).json({ error: 'No hay clientes registrados' });

        // Ejecutar en segundo plano para no bloquear la petición
        sendBroadcast(botSock, clients, campaign.text, campaign.image_url)
            .then(() => console.log(`Campaña ${campaign.id} finalizada.`))
            .catch(err => console.error(`Error en campaña ${campaign.id}:`, err));

        res.json({ ok: true, message: `Iniciando envío a ${clients.length} clientes.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cotizaciones ─────────────────────────────────────────────────────────────
app.get('/quotes', (_req, res) => {
    res.sendFile(path.join(__dirname, 'quotes.html'));
});

app.get('/api/quotes', async (_req, res) => {
    try {
        const quotes = await getAllQuotes();
        res.json(quotes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/quotes/:id/details', async (req, res) => {
    try {
        const details = await getQuoteDetailsById(req.params.id);
        res.json(details);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/quotes/:id', async (req, res) => {
    const quoteId = parseInt(req.params.id, 10);
    try {
        const quotes = await getAllQuotes();
        const quote = quotes.find(q => q.id === quoteId);
        if (!quote) {
            return res.status(404).json({ error: 'Cotización no encontrada en SQLite.' });
        }

        // Si está sincronizado con MS SQL, intentar borrarlo de allí primero
        if (quote.synced === 1 && quote.sql_pedido_id) {
            try {
                const mssqlResult = await deleteSqlPedido(quote.sql_pedido_id);
                if (!mssqlResult.deleted) {
                    if (mssqlResult.reason === 'not_pending') {
                        return res.status(400).json({
                            error: 'not_pending',
                            message: `El pedido #${quote.sql_pedido_id} ya no está pendiente (Estado actual: ${mssqlResult.estado}). No se permite eliminar.`
                        });
                    }
                }
            } catch (err) {
                console.error(`[API-DELETE] Error conectando a MS SQL para borrar cotización #${quoteId}:`, err);
                return res.status(500).json({
                    error: 'mssql_offline',
                    message: 'No se pudo conectar a la base de datos MS SQL para verificar y eliminar el pedido. Operación cancelada para mantener la integridad de los datos.'
                });
            }
        }

        // Si la eliminación en MS SQL fue exitosa (o no estaba sincronizado)
        await deleteQuote(quoteId);
        
        // Guardar registro en logs locales para trazabilidad
        const logMsg = `Cotización #${quoteId} (${quote.client_name || 'Sin nombre'}) eliminada por el usuario.` + 
            (quote.sql_pedido_id ? ` También se eliminó de MS SQL (Pedido #${quote.sql_pedido_id}).` : '');
        await saveLog('INFO', 'api', logMsg);

        res.json({ ok: true });
    } catch (err) {
        console.error('Error en DELETE /api/quotes/:id:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─── Sincronización manual de productos ──────────────────────────────────────
app.post('/api/sync/products', async (_req, res) => {
    try {
        // Ejecutar en background para no bloquear la respuesta
        syncProducts().catch(err => console.error('[SYNC-MANUAL]', err.message));
        res.json({ ok: true, message: 'Sincronización iniciada. Revisa los logs para ver el resultado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Logs ─────────────────────────────────────────────────────────────────────
app.get('/logs', (_req, res) => {
    res.sendFile(path.join(__dirname, 'logs.html'));
});

app.get('/api/logs', async (req, res) => {
    try {
        const { level, source, limit } = req.query;
        const logs = await getLogs({
            level: level || null,
            source: source || null,
            limit: limit ? parseInt(limit) : 200
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/logs', async (req, res) => {
    try {
        const days = req.query.days ? parseInt(req.query.days) : 30;
        await clearLogs(days);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Servir logo para el simulador
app.use('/logo.png', express.static(path.join(__dirname, 'logo.png')));
app.use('/logo.jpg', express.static(path.join(__dirname, 'logo.jpg')));

let botSock = null;

app.listen(PORT, () => {
    console.log(`Servidor Express corriendo en http://localhost:${PORT}`);
});

startBot().then(sock => {
    botSock = sock;
    startSyncTask(); // Iniciar tarea de sincronización con MS SQL
}).catch(err => {
    console.error('Error iniciando el bot:', err);
});
