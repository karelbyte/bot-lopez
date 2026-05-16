const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { connectToDatabase, searchProducts, createSqlClient, createSqlPedido } = require('./db.js');
const { getUser, createUser, updateUserCode, addItemToQuote, getPendingQuote, finalizeQuote, clearPendingQuote, getActivePromotions } = require('./localDb.js');
const { generateQuotePdf } = require('./pdfGenerator.js');

const botState = {
    qr: null,
    connected: false,
    hasConnected: false
};

// Máquina de estados en memoria para cada usuario
const userSessions = {};

function getSession(identifier) {
    if (!userSessions[identifier]) {
        userSessions[identifier] = {
            state: 'IDLE',   // IDLE, ASKING_NAME, SELECTING_ITEM, ASKING_QUANTITY
            allResults: [],  // todos los resultados de la búsqueda actual
            searchPage: 0,   // página actual (0-based)
            searchResults: [],// resultados de la página actual (los que ve el usuario)
            selectedItem: null
        };
    }
    return userSessions[identifier];
}

const PAGE_SIZE = 15;

// Construye el mensaje de resultados para la página actual y actualiza session.searchResults
function buildResultsPage(session) {
    const start = session.searchPage * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageItems = session.allResults.slice(start, end);
    const hasMore = end < session.allResults.length;
    const total = session.allResults.length;

    session.searchResults = pageItems;

    const pageNum = session.searchPage + 1;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    let msj = `🔍 *Resultados de búsqueda* (${pageNum}/${totalPages} — ${total} encontrados):\n\n`;
    pageItems.forEach((r, i) => {
        const precioFinal = r.IMPUESTO === 'IVA' ? Math.ceil(r.PRECIO1 * 1.16) : r.PRECIO1;
        msj += `*${i + 1}.* ${r.DESCRIP} - $${precioFinal.toFixed(2)}\n`;
    });

    if (hasMore) {
        msj += `\n*0.* Ver más resultados ➡️`;
        msj += `\n\n👉 Escribe el *número* para agregar a tu cotización, *0* para ver más, o busca otra palabra.`;
    } else {
        msj += `\n\n👉 Escribe el *número* para agregar a tu cotización, o busca otra palabra.`;
    }

    return msj;
}

/**
 * Lógica central del bot. Procesa un mensaje de texto de un usuario
 * y devuelve un array de respuestas { type, text, pdfPath }.
 * - type: 'text' | 'image_text' | 'pdf'
 * - text: string con el mensaje
 * - pdfPath: ruta al PDF (solo cuando type === 'pdf')
 * - hasLogo: true si debe acompañarse del logo (solo cuando type === 'image_text')
 *
 * @param {string} phone
 * @param {string} textMessage
 * @param {boolean} dryRun - Si es true, no escribe nada en SQLite ni MS SQL.
 *                           Las búsquedas de productos sí se ejecutan (lectura real).
 *                           La sesión en memoria sí se usa (no es persistente).
 */
async function processMessage(identifier, textMessage, dryRun = false) {
    const responses = [];
    const textLower = textMessage.toLowerCase().trim();
    const session = getSession(identifier);

    const reply = (text) => responses.push({ type: 'text', text });
    const replyWithLogo = (text) => responses.push({ type: 'image_text', text });
    const replyPdf = (pdfPath, caption) => responses.push({ type: 'pdf', pdfPath, text: caption });

    const handlePromotions = async (position) => {
        try {
            const promos = await getActivePromotions(position);
            for (const promo of promos) {
                if (promo.image_url) {
                    responses.push({ type: 'image', text: promo.text, url: promo.image_url });
                } else {
                    responses.push({ type: 'text', text: promo.text });
                }
            }
        } catch (err) {
            console.error('Error al manejar promociones:', err);
        }
    };

    // En dryRun simulamos un usuario ficticio en memoria sin tocar SQLite
    const simulatedUser = dryRun ? (session.simulatedUser || null) : null;

    try {
        // 1. Verificar si el usuario existe
        let user = dryRun ? simulatedUser : await getUser(identifier);

        if (!user) {
            if (session.state !== 'ASKING_NAME') {
                session.state = 'ASKING_NAME';
                await handlePromotions('WELCOME');
                const welcomeText = `¡Hola! Bienvenido a *Lopez Impresores*.
🌐 https://lopezimpresores.mx/
📞 (755) 554-2478 y 554-2578
✉️ ventas@lopezimpresores.mx

Para comenzar y proporcionarte un mejor servicio, ¿me podrías decir tu nombre y apellido?`;
                replyWithLogo(welcomeText);
            } else {
                if (!dryRun) {
                    await createUser(identifier, textMessage);
                } else {
                    // En dryRun guardamos el usuario solo en memoria
                    session.simulatedUser = { phone: identifier, name: textMessage };
                }
                session.state = 'IDLE';
                await handlePromotions('POST_NAME');
                reply(`¡Gracias, ${textMessage}! Ya te hemos registrado.\n\n¿Qué artículo deseas buscar o cotizar? Escribe el nombre o parte del nombre.`);
            }
            return responses;
        }

        // Finalizar cotización
        if (['terminar', 'fin', 'cotizar'].includes(textLower)) {
            // En dryRun los ítems están en memoria
            const pending = dryRun
                ? (session.simulatedQuote || [])
                : await getPendingQuote(identifier);

            if (pending.length === 0) {
                reply('No tienes artículos en tu cotización actual. Escribe un producto para buscar.');
                return responses;
            }

            reply('⏳ Generando tu cotización en formato PDF, por favor espera un momento...');

            try {
                let pedidoId = null;
                if (!dryRun) {
                    try {
                        pedidoId = await createSqlPedido(pending, user.name);
                    } catch (sqlErr) {
                        console.error('Error al registrar pedido en SQL:', sqlErr);
                    }
                }

                const pdfPath = await generateQuotePdf(user, pending, pedidoId);
                
                let orderMsg = `¡Listo, ${user.name}! Aquí tienes tu cotización en PDF.\n\n¡Gracias por cotizar con nosotros!`;

                if (pedidoId) {
                    orderMsg += `\n\n✅ Se ha generado la cotización oficial en nuestro sistema con el número: *${pedidoId}*`;
                }

                if (!dryRun) {
                    await finalizeQuote(identifier, pedidoId);
                }

                replyPdf(pdfPath, orderMsg);

                // Limpiar estado de la sesión
                delete session.state;
                delete session.selectedItem;
                if (dryRun) delete session.simulatedQuote;
            } catch (err) {
                console.error('Error generando PDF:', err);
                reply('Hubo un error al generar el PDF. Por favor intenta de nuevo.');
            }

            if (!dryRun) {
                await finalizeQuote(identifier);
            } else {
                session.simulatedQuote = [];
            }
            session.state = 'IDLE';
            return responses;
        }

        // Cancelar cotización
        if (textLower === 'cancelar') {
            if (!dryRun) {
                await clearPendingQuote(identifier);
            } else {
                session.simulatedQuote = [];
            }
            session.state = 'IDLE';
            session.searchResults = [];
            session.allResults = [];
            session.searchPage = 0;
            session.selectedItem = null;
            reply('Cotización cancelada. ¿Qué artículo deseas buscar?');
            return responses;
        }

        // Saludos genéricos
        const genericPhrases = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos', 'ok', 'gracias', 'gracias!'];
        if (session.state === 'IDLE' && genericPhrases.includes(textLower)) {
            if (!dryRun) {
                await clearPendingQuote(identifier);
            } else {
                session.simulatedQuote = [];
            }
            const returnWelcomeText = `¡Hola de nuevo, ${user.name}! 👋 Bienvenido a *Lopez Impresores*.
🌐 https://lopezimpresores.mx/
📞 (755) 554-2478 y 554-2578
✉️ ventas@lopezimpresores.mx

👉 Escribe el nombre o clave de un artículo para buscarlo en nuestro inventario.
_(Ejemplo: "libreta", "lapiz", "cartulina")_`;
            replyWithLogo(returnWelcomeText);
            return responses;
        }

        // Flujo por estado
        if (session.state === 'IDLE' || session.state === 'ASKING_NAME') {
            session.state = 'IDLE';

            if (textMessage.length < 3) {
                reply('Para buscar un artículo, por favor escribe al menos 3 letras de su nombre o descripción.');
                return responses;
            }

            const results = await searchProducts(textMessage);

            if (results.length === 0) {
                reply(`No encontré ningún artículo que coincida con "${textMessage}".\n\nVerifica que esté bien escrito o intenta con una palabra más general.`);
                return responses;
            }

            session.allResults = results;
            session.searchPage = 0;
            session.state = 'SELECTING_ITEM';

            reply(buildResultsPage(session));

        } else if (session.state === 'SELECTING_ITEM') {
            const num = parseInt(textMessage, 10);

            // 0 = ver más resultados
            if (num === 0) {
                const nextStart = (session.searchPage + 1) * PAGE_SIZE;
                if (nextStart >= session.allResults.length) {
                    reply('Ya estás viendo todos los resultados. Escribe el número del artículo que deseas.');
                } else {
                    session.searchPage += 1;
                    reply(buildResultsPage(session));
                }

            // Número válido de la página actual
            } else if (!isNaN(num) && num > 0 && num <= session.searchResults.length) {
                session.selectedItem = session.searchResults[num - 1];
                session.state = 'ASKING_QUANTITY';
                reply(`Has seleccionado: *${session.selectedItem.DESCRIP}*\n\n¿Qué *cantidad* deseas agregar a la cotización? (Escribe un número)`);

            // No es número válido → nueva búsqueda
            } else {
                const results = await searchProducts(textMessage);
                if (results.length === 0) {
                    reply(`No encontré ningún artículo que coincida con "${textMessage}".\n\nVerifica que esté bien escrito o intenta con una palabra más general.`);
                    return responses;
                }
                session.allResults = results;
                session.searchPage = 0;
                reply(buildResultsPage(session));
            }

        } else if (session.state === 'ASKING_QUANTITY') {
            const cantidad = parseInt(textMessage, 10);
            if (!isNaN(cantidad) && cantidad > 0) {
                const item = session.selectedItem;
                const precioBase = item.PRECIO1;
                const totalUnitario = item.IMPUESTO === 'IVA' ? Math.ceil(precioBase * 1.16) : precioBase;
                const montoIva = totalUnitario - precioBase;

                if (!dryRun) {
                    await addItemToQuote(identifier, item.ARTICULO, item.DESCRIP, cantidad, precioBase, montoIva, totalUnitario, item.IMPUESTO);
                } else {
                    // Acumular ítems en memoria para poder generar el PDF de prueba
                    if (!session.simulatedQuote) session.simulatedQuote = [];
                    session.simulatedQuote.push({
                        articulo: item.ARTICULO,
                        descrip:  item.DESCRIP,
                        cantidad,
                        precio_unitario: precioBase,
                        monto_iva: montoIva,
                        total_unitario: totalUnitario,
                        impuesto: item.IMPUESTO
                    });
                }

                session.state = 'IDLE';
                session.selectedItem = null;
                session.searchResults = [];
                reply(`✅ Se agregó *${cantidad}x ${item.DESCRIP}* a tu cotización.\n\nPara buscar otro artículo, escribe su nombre. \n\nSi ya terminaste y quieres tu cotizacion en formato PDF, escribe *terminar*. Si deseas borrar todo y empezar una nueva cotizacion, escribe *cancelar*.`);
            } else {
                reply('Por favor, escribe una cantidad válida (un número mayor a 0).');
            }
        }

    } catch (error) {
        console.error('Error en el flujo del bot:', error);
        reply('Ocurrió un error al procesar tu solicitud. Por favor intenta más tarde.');
    }

    return responses;
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const pushName = msg.pushName || 'Cliente';
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

            console.log(`[BOT] Mensaje de: ${pushName} (${from})`);

            // Ignorar mensajes de grupos o estados
            if (from.endsWith('@g.us') || from === 'status@broadcast') continue;

            // Verificar si el usuario existe en SQLite
            let user = await getUser(from);
            // No creamos el usuario automáticamente para permitir que el bot le pregunte su nombre real en el flujo de bienvenida

            if (!textMessage) continue;

            // Procesar el mensaje usando el JID completo como identificador
            const responses = await processMessage(from, textMessage);

            for (const res of responses) {
                if (res.type === 'text') {
                    await sock.sendMessage(from, { text: res.text }, { quoted: msg });

                } else if (res.type === 'image_text') {
                    const logoPng = path.join(__dirname, 'logo.png');
                    const logoJpg = path.join(__dirname, 'logo.jpg');
                    if (fs.existsSync(logoPng)) {
                        await sock.sendMessage(from, { image: { url: logoPng }, caption: res.text }, { quoted: msg });
                    } else if (fs.existsSync(logoJpg)) {
                        await sock.sendMessage(from, { image: { url: logoJpg }, caption: res.text }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: res.text }, { quoted: msg });
                    }

                } else if (res.type === 'image') {
                    const finalImageUrl = res.url.startsWith('/') ? path.join(__dirname, res.url) : res.url;
                    await sock.sendMessage(from, { image: { url: finalImageUrl }, caption: res.text }, { quoted: msg });

                } else if (res.type === 'pdf') {
                    const now = new Date();
                    const dd = String(now.getDate()).padStart(2, '0');
                    const mm = String(now.getMonth() + 1).padStart(2, '0');
                    const yyyy = now.getFullYear();
                    const pdfFileName = `Cotizacion_Lopez_Impresores_${dd}_${mm}_${yyyy}.pdf`;
                    await sock.sendMessage(from, {
                        document: { url: res.pdfPath },
                        mimetype: 'application/pdf',
                        fileName: pdfFileName,
                        caption: res.text
                    });
                }
            }
        }
    });

    return sock;
}

/**
 * Envía una campaña a una lista de clientes
 */
async function sendBroadcast(sock, clients, text, imagePath) {
    if (!sock) throw new Error('Bot no conectado');
    console.log(`[CAMPAÑA] Iniciando envío masivo a ${clients.length} clientes registrados.`);
    
    for (const client of clients) {
        const jid = client.phone.includes('@') ? client.phone : `${client.phone}@s.whatsapp.net`;
        
        // No enviar al simulador
        if (jid.includes('simulator')) {
            console.log(`[CAMPAÑA] Saltando contacto de simulador: ${jid}`);
            continue;
        }

        try {
            console.log(`[CAMPAÑA] Intentando enviar a: ${jid}...`);
            const personalizedText = text.replace(/\[nombre\]/gi, client.name || 'Cliente');
            
            if (imagePath) {
                const absolutePath = path.join(__dirname, imagePath);
                await sock.sendMessage(jid, { image: { url: absolutePath }, caption: personalizedText });
            } else {
                await sock.sendMessage(jid, { text: personalizedText });
            }
            
            console.log(`[CAMPAÑA] ✅ Mensaje enviado correctamente a: ${jid}`);
            
            const delay = Math.floor(Math.random() * 4000) + 4000;
            await new Promise(resolve => setTimeout(resolve, delay));
            
        } catch (err) {
            console.error(`[CAMPAÑA] ❌ Error enviando a ${jid}:`, err);
        }
    }
}

module.exports = {
    startBot,
    botState,
    processMessage,
    userSessions,
    sendBroadcast
};
