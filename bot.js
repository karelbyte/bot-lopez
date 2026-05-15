const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { connectToDatabase, searchProducts, createSqlClient } = require('./db.js');
const { getUser, createUser, updateUserCode, addItemToQuote, getPendingQuote, finalizeQuote, clearPendingQuote } = require('./localDb.js');
const { generateQuotePdf } = require('./pdfGenerator.js');

const botState = {
    qr: null,
    connected: false,
    hasConnected: false
};

// Máquina de estados en memoria para cada usuario
const userSessions = {};

function getSession(phone) {
    if (!userSessions[phone]) {
        userSessions[phone] = {
            state: 'IDLE', // IDLE, ASKING_NAME, SELECTING_ITEM, ASKING_QUANTITY
            searchResults: [],
            selectedItem: null
        };
    }
    return userSessions[phone];
}

async function startBot() {
    try {
        await connectToDatabase();
    } catch (err) {
        console.warn('⚠️ No se pudo conectar a MS SQL al iniciar.');
    }

    const authDir = path.join(__dirname, 'sessions', 'bot_session');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Bot Lopez', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) botState.qr = qr;
        if (connection === 'close') {
            botState.connected = false;
            botState.qr = null;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startBot, 5000);
        } else if (connection === 'open') {
            console.log('✅ Bot conectado exitosamente a WhatsApp!');
            botState.connected = true;
            botState.hasConnected = true;
            botState.qr = null;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!textMessage) return;

        const textLower = textMessage.toLowerCase().trim();
        const phone = from.split('@')[0];
        const session = getSession(phone);

        try {
            // 1. Verificar si el usuario existe
            let user = await getUser(phone);

            if (!user) {
                if (session.state !== 'ASKING_NAME') {
                    session.state = 'ASKING_NAME';

                    const welcomeText = `¡Hola! Bienvenido a *Lopez Impresores*.
🌐 https://lopezimpresores.mx/
📞 (755) 554-2478 y 554-2578
✉️ ventas@lopezimpresores.mx

Para comenzar, ¿me podrías decir tu nombre?`;

                    if (fs.existsSync(path.join(__dirname, 'logo.png'))) {
                        await sock.sendMessage(from, { image: { url: path.join(__dirname, 'logo.png') }, caption: welcomeText }, { quoted: msg });
                    } else if (fs.existsSync(path.join(__dirname, 'logo.jpg'))) {
                        await sock.sendMessage(from, { image: { url: path.join(__dirname, 'logo.jpg') }, caption: welcomeText }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: welcomeText }, { quoted: msg });
                    }

                    return;
                } else {
                    // Guardar al nuevo usuario
                    await createUser(phone, textMessage);
                    session.state = 'IDLE';
                    await sock.sendMessage(from, { text: `¡Gracias, ${textMessage}! Ya te hemos registrado.\n\n¿Qué artículo deseas buscar o cotizar? Escribe el nombre o parte del nombre.` });
                    return;
                }
            }

            // Si el usuario envía 'terminar', 'fin' o 'cotizar' finalizamos
            if (['terminar', 'fin', 'cotizar'].includes(textLower)) {
                const pending = await getPendingQuote(phone);
                if (pending.length === 0) {
                    await sock.sendMessage(from, { text: 'No tienes artículos en tu cotización actual. Escribe un producto para buscar.' });
                    return;
                }

                await sock.sendMessage(from, { text: '⏳ Generando tu cotización en formato PDF, por favor espera un momento...' });

                try {
                    // Generar PDF
                    const pdfPath = await generateQuotePdf(user, pending);

                    // Enviar PDF como documento adjunto
                    await sock.sendMessage(from, {
                        document: { url: pdfPath },
                        mimetype: 'application/pdf',
                        fileName: `Cotizacion_Lopez_Impresores.pdf`,
                        caption: `¡Listo, ${user.name}! Aquí tienes tu cotización en PDF.\n\n¡Gracias por cotizar con nosotros!`
                    });

                    // Registrar cliente en la base de datos SQL y guardar el código en SQLite
                    const clientCode = await createSqlClient(user.name);
                    if (clientCode) {
                        await updateUserCode(phone, clientCode);
                    }

                } catch (err) {
                    console.error('Error generando PDF:', err);
                    await sock.sendMessage(from, { text: 'Hubo un error al generar el PDF. Por favor intenta de nuevo.' });
                }

                await finalizeQuote(phone);
                session.state = 'IDLE';
                return;
            }

            // Si el usuario escribe "cancelar" en cualquier momento
            if (textLower === 'cancelar') {
                await clearPendingQuote(phone);
                session.state = 'IDLE';
                session.searchResults = [];
                session.selectedItem = null;
                await sock.sendMessage(from, { text: 'Cotización cancelada. ¿Qué artículo deseas buscar?' });
                return;
            }

            // Manejar saludos comunes o respuestas genéricas cuando está IDLE
            const genericPhrases = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos', 'ok', 'gracias', 'gracias!'];
            if (session.state === 'IDLE' && genericPhrases.includes(textLower)) {
                // "Nada es histórico": Al saludar, limpiamos cualquier cotización anterior
                await clearPendingQuote(phone);
                
                const returnWelcomeText = `¡Hola de nuevo, ${user.name}! 👋 Bienvenido a *Lopez Impresores*.
🌐 https://lopezimpresores.mx/
📞 (755) 554-2478 y 554-2578
✉️ ventas@lopezimpresores.mx

👉 Escribe el nombre o clave de un artículo para buscarlo en nuestro inventario.
_(Ejemplo: "libreta", "lapiz", "cartulina")_`;

                if (fs.existsSync(path.join(__dirname, 'logo.png'))) {
                    await sock.sendMessage(from, { image: { url: path.join(__dirname, 'logo.png') }, caption: returnWelcomeText }, { quoted: msg });
                } else if (fs.existsSync(path.join(__dirname, 'logo.jpg'))) {
                    await sock.sendMessage(from, { image: { url: path.join(__dirname, 'logo.jpg') }, caption: returnWelcomeText }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: returnWelcomeText }, { quoted: msg });
                }
                return;
            }

            // Flujo según el estado actual
            if (session.state === 'IDLE' || session.state === 'ASKING_NAME') {
                session.state = 'IDLE'; // por si venia de ASKING_NAME bugeado

                // Evitar búsquedas de un solo caracter o basura corta
                if (textMessage.length < 3) {
                    await sock.sendMessage(from, { text: 'Para buscar un artículo, por favor escribe al menos 3 letras de su nombre o descripción.' });
                    return;
                }

                const results = await searchProducts(textMessage);

                if (results.length === 0) {
                    await sock.sendMessage(from, { text: `No encontré ningún artículo que coincida con "${textMessage}".\n\nVerifica que esté bien escrito o intenta con una palabra más general.` });
                    return;
                }

                session.searchResults = results;
                session.state = 'SELECTING_ITEM';

                let msj = `🔍 *Resultados de búsqueda:*\n\n`;
                results.forEach((r, i) => {
                    msj += `*${i + 1}.* ${r.DESCRIP} - $${r.PRECIO1.toFixed(2)}\n`;
                });
                msj += `\n👉 Escribe el *número* para agregarlo a tu cotización, o busca otra palabra para una nueva búsqueda.`;

                await sock.sendMessage(from, { text: msj });

            } else if (session.state === 'SELECTING_ITEM') {
                const num = parseInt(textMessage, 10);
                if (!isNaN(num) && num > 0 && num <= session.searchResults.length) {
                    session.selectedItem = session.searchResults[num - 1];
                    session.state = 'ASKING_QUANTITY';
                    await sock.sendMessage(from, { text: `Has seleccionado: *${session.selectedItem.DESCRIP}*\n\n¿Qué *cantidad* deseas agregar a la cotización? (Escribe un número)` });
                } else {
                    // Si no escribió un número válido de la lista, asumimos que quiere buscar otra cosa
                    const results = await searchProducts(textMessage);
                    if (results.length === 0) {
                        await sock.sendMessage(from, { text: 'No encontré ningún artículo, y el número ingresado no era válido. Intenta de nuevo.' });
                        return;
                    }
                    session.searchResults = results;
                    let msj = `🔍 *Resultados de búsqueda:*\n\n`;
                    results.forEach((r, i) => {
                        msj += `*${i + 1}.* ${r.DESCRIP} - $${r.PRECIO1.toFixed(2)}\n`;
                    });
                    msj += `\n👉 Escribe el *número* del artículo que deseas cotizar.`;
                    await sock.sendMessage(from, { text: msj });
                }

            } else if (session.state === 'ASKING_QUANTITY') {
                const cantidad = parseInt(textMessage, 10);
                if (!isNaN(cantidad) && cantidad > 0) {
                    const item = session.selectedItem;
                    await addItemToQuote(phone, item.ARTICULO, item.DESCRIP, item.PRECIO1, cantidad);

                    session.state = 'IDLE';
                    session.selectedItem = null;
                    session.searchResults = [];

                    await sock.sendMessage(from, { text: `✅ Se agregó *${cantidad}x ${item.DESCRIP}* a tu cotización.\n\nPara buscar otro artículo, escribe su nombre. \n\nSi ya terminaste y quieres tu cotizacion en formatoPDF, escribe *terminar*. Si deseas borrar todo y empezar una nueva cotizacion, escribe *cancelar*.` });
                } else {
                    await sock.sendMessage(from, { text: 'Por favor, escribe una cantidad válida (un número mayor a 0).' });
                }
            }

        } catch (error) {
            console.error('Error en el flujo del bot:', error);
            await sock.sendMessage(from, { text: 'Ocurrió un error al procesar tu solicitud. Por favor intenta más tarde.' });
        }
    });

    return sock;
}

module.exports = {
    startBot,
    botState
};
