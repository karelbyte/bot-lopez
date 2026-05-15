require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { startBot, botState, processMessage, userSessions } = require('./bot.js');

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
    if (botState.hasConnected) {
        const content = `
            <h1>✅ Bot Conectado</h1>
            <p>El bot de <strong>Lopez Impresores</strong> está activo y listo para cotizar.</p>
            <div class="status-badge active">
                Estado: ${botState.connected ? 'Conectado a WhatsApp' : 'Intentando reconectar...'}
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
                    if (data.hasConnected) window.location.replace('/');
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
                // Devolver URL de descarga en lugar de ruta local
                const fileName = path.basename(r.pdfPath);
                return { type: 'pdf', text: r.text, url: `/quotes_pdfs/${fileName}` };
            }
            return { type: r.type, text: r.text };
        });

        res.json({ responses: output });
    } catch (err) {
        console.error('Error en /chat:', err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Servir PDFs generados para el simulador
app.use('/quotes_pdfs', express.static(path.join(__dirname, 'quotes_pdfs')));

// ─── Simulador: UI ────────────────────────────────────────────────────────────
app.get('/simulator', (_req, res) => {
    res.sendFile(path.join(__dirname, 'simulator.html'));
});

// Servir logo para el simulador
app.use('/logo.png', express.static(path.join(__dirname, 'logo.png')));
app.use('/logo.jpg', express.static(path.join(__dirname, 'logo.jpg')));

app.listen(PORT, () => {
    console.log(`Servidor Express corriendo en http://localhost:${PORT}`);
});

startBot().catch(err => {
    console.error('Error iniciando el bot:', err);
});
