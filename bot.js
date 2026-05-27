const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { connectToDatabase, searchProducts, createSqlClient, createSqlPedido, getSqlPedidoStatus } = require('./db.js');
const { getUser, createUser, updateUserCode, addItemToQuote, getPendingQuote, finalizeQuote, clearPendingQuote, getActivePromotions, saveLog, getLocalPedidoStatus, deleteQuoteDetailById, updateQuoteDetailQuantityById, updateQuoteDetailPriceById, getProductByArticulo } = require('./localDb.js');
const { generateQuotePdf } = require('./pdfGenerator.js');

const botState = {
    qr: null,
    connected: false,
    hasConnected: false
};

// Máquina de estados en memoria para cada usuario
const userSessions = {};

function getSession(identifier) {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;

    if (!userSessions[identifier]) {
        userSessions[identifier] = {
            state: 'IDLE',
            allResults: [],
            searchPage: 0,
            searchResults: [],
            selectedItem: null,
            selectionQueue: [],
            lastActivity: now
        };
    } else {
        // Verificar si la sesión expiró
        if (now - userSessions[identifier].lastActivity > TWO_HOURS) {
            console.log(`[SESSION] Sesión expirada para ${identifier}. Reiniciando...`);
            userSessions[identifier] = {
                state: 'IDLE',
                allResults: [],
                searchPage: 0,
                searchResults: [],
                selectedItem: null,
                selectionQueue: [],
                lastActivity: now
            };
        } else {
            // Actualizar tiempo de actividad
            userSessions[identifier].lastActivity = now;
        }
    }
    return userSessions[identifier];
}

/**
 * Calcula el IVA y el precio total unitario a partir del precio base.
 * Usa redondeo a 2 decimales (no Math.ceil) para evitar precios inflados.
 * @param {number} precioBase - Precio sin impuesto.
 * @param {string|null} impuesto - 'IVA' si aplica, cualquier otro valor = exento.
 * @returns {{ totalUnitario: number, montoIva: number }}
 */
function calcularIva(precioBase, impuesto) {
    if (impuesto === 'IVA') {
        const totalUnitario = Math.round(precioBase * 1.16 * 100) / 100;
        const montoIva      = Math.round((totalUnitario - precioBase) * 100) / 100;
        return { totalUnitario, montoIva };
    }
    return { totalUnitario: precioBase, montoIva: 0 };
}

/**
 * Selecciona el precio de un producto basado en la cantidad y los campos C2-C10.
 * @param {object} item - El objeto producto con PRECIO1-10 y C2-10.
 * @param {number} cantidad - La cantidad deseada por el usuario.
 * @returns {{price: number, priceLevel: string}} - El precio unitario y el nivel de precio aplicado (ej. 'PRECIO3').
 */
function selectPriceByQuantity(item, cantidad) {
    let selectedPrice = parseFloat(item.PRECIO1) || 0;
    let priceLevel = 'PRECIO1';
    let matchedC = null;
    let matchedIndex = null;

    // Iterar de C10 a C2 para encontrar el umbral más alto que cumpla
    for (let i = 10; i >= 2; i--) {
        const cKey = 'C' + i;
        const precioKey = 'PRECIO' + i;
        const cValue = parseFloat(item[cKey]);
        const precioValue = parseFloat(item[precioKey]);

        if (!isNaN(cValue) && cValue > 0 && cantidad >= cValue && !isNaN(precioValue) && precioValue >= 0) {
            selectedPrice = precioValue;
            priceLevel = precioKey;
            matchedC = cValue;
            matchedIndex = i;
            break; // Se encontró el umbral, salir del bucle
        }
    }
    return { price: selectedPrice, priceLevel: priceLevel, matchedC, matchedIndex };
}

const PAGE_SIZE = 10;

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
        msj += `*${i + 1}.* ${r.DESCRIP}\n`;
    });

    if (hasMore) {
        msj += `\n*0.* Ver más resultados ➡️`;
        msj += `\n\n👉 Escribe el *número* para agregar a tu cotización y especificar la cantidad.`;
    } else {
        msj += `\n\n👉 Escribe el *número* para agregar a tu cotización y especificar la cantidad.`;
    }

    return msj;
}

async function formatQuoteSummary(identifier, simulatedQuote = null) {
    const pending = simulatedQuote !== null
        ? simulatedQuote
        : await getPendingQuote(identifier);

    if (!pending || pending.length === 0) {
        return '🛒 *Tu cotización está vacía.*\n\nEscribe el nombre o descripción de un artículo para buscar y comenzar a cotizar.';
    }

    let msg = `📋 *Tu Cotización Actual:*\n\n`;
    let subtotal = 0;
    let totalIva = 0;
    let total = 0;

    pending.forEach((it, i) => {
        const itemSubtotal = it.precio_unitario * it.cantidad;
        const itemIva = it.monto_iva * it.cantidad;
        const itemTotal = it.total_unitario * it.cantidad;

        subtotal += itemSubtotal;
        totalIva += itemIva;
        total += itemTotal;

        msg += `*${i + 1}.* ${it.descrip}\n`;
        msg += `   ${it.cantidad} X $${it.total_unitario.toFixed(2)} = *$${itemTotal.toFixed(2)}*\n\n`;
    });

    msg += `💵 *TOTAL NETO:* $${total.toFixed(2)}\n\n`;

    msg += `✏️ *¿Deseas modificar algo?*\n`;
    msg += `• Para *cambiar la cantidad*, escribe: *cambiar [número] a [cantidad]* (Ejemplo: \`cambiar 1 a 5\` o simplemente \`1 a 5\`)\n`;
    msg += `• Para *eliminar un producto*, escribe: *eliminar [número]* o *quitar [número]* (Ejemplo: \`eliminar 2\`)\n\n`;
    msg += `• Para *agregar más artículos*, escribe el nombre o la descripción del producto.\n\n`;
    msg += `👉 Escribe *terminar* para generar tu cotización, o escribe *cancelar* para limpiar todo.`;

    return msg;
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
async function executeProductSearch(textMessage, session, responses) {
    const reply = (text) => responses.push({ type: 'text', text });

    // Detectar si el cliente envió una lista separada por comas
    const terms = textMessage.split(',')
        .map(t => t.trim())
        .filter(t => t.length >= 3);

    let allResults = [];
    if (terms.length > 1) {
        // Búsqueda múltiple — combinamos todos los resultados deduplicando por código
        const seen = new Set();
        for (const term of terms) {
            const results = await searchProducts(term);
            for (const r of results) {
                if (!seen.has(r.ARTICULO)) {
                    seen.add(r.ARTICULO);
                    allResults.push(r);
                }
            }
        }
    } else {
        // Búsqueda simple — flujo normal
        const searchTerm = terms[0] || textMessage;
        allResults = await searchProducts(searchTerm);
    }

    if (allResults.length === 0) {
        const queryText = terms.length > 1 ? terms.join(', ') : (terms[0] || textMessage);
        reply(`No encontré ningún artículo que coincida con "${queryText}".\n\nVerifica que esté bien escrito o intenta con una palabra más general.`);
        return;
    }

    session.allResults = allResults;
    session.searchPage = 0;
    session.state = 'SELECTING_ITEM';

    reply(buildResultsPage(session));
}

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
        // Interceptar consulta de folio de pedido (ej: PE12345, PE-12345, pedido 12345, folio-12345)
        const orderQueryMatch = textLower.match(/^(?:pe-?|folio-?|pedido-?\s*)(\d+)$/i);
        if (orderQueryMatch) {
            const pedidoId = parseInt(orderQueryMatch[1], 10);
            reply(`⏳ Buscando detalles de la cotización *PE${pedidoId}*, por favor espera...`);

            try {
                let orderData = null;
                let isOfflineFallback = false;

                try {
                    orderData = await getSqlPedidoStatus(pedidoId);
                } catch (sqlErr) {
                    console.warn(`[BOT-QUERY] MS SQL offline al buscar pedido PE${pedidoId}. Intentando SQLite.`, sqlErr.message);
                    isOfflineFallback = true;
                    // Intentar desde la caché local de SQLite
                    orderData = await getLocalPedidoStatus(pedidoId);
                }

                if (orderData) {
                    // Mapear el estado a un texto elegante y amigable en español
                    let estadoDecorado = '';
                    let guiaCaja = '';

                    switch (orderData.estado) {
                        case 'PE':
                        case 'pending':
                            estadoDecorado = '⏳ COTIZADO / PENDIENTE DE CAJA';
                            guiaCaja = '\n👉 *¿Qué sigue?* Pasa a caja con tu número de folio para realizar el pago e iniciar la producción de tus artículos.';
                            break;
                        case 'SU':
                        case 'delivered':
                            estadoDecorado = '📦 SURTIDO / ENTREGADO';
                            guiaCaja = '\n👉 *Nota:* ¡Tu pedido ya ha sido completado y entregado en mostrador!';
                            break;
                        case 'CA':
                        case 'cancelled':
                            estadoDecorado = '❌ CANCELADO';
                            guiaCaja = '\n👉 *Nota:* Esta cotización o pedido ha sido cancelado.';
                            break;
                        case 'FA':
                        case 'invoiced':
                            estadoDecorado = '📄 FACTURADO';
                            guiaCaja = '\n👉 *Nota:* Tu pedido ha sido facturado y procesado.';
                            break;
                        case 'CO':
                        case 'paid':
                            estadoDecorado = '💵 PAGADO';
                            guiaCaja = '\n👉 *Nota:* Tu pedido ya ha sido pagado y se encuentra actualmente en producción.';
                            break;
                        default:
                            estadoDecorado = `📌 ${orderData.estado}`;
                            guiaCaja = '';
                    }

                    // Formatear la fecha
                    const fechaFormat = new Date(orderData.fecha).toLocaleDateString('es-MX', {
                        day: '2-digit',
                        month: 'long',
                        year: 'numeric'
                    });

                    // Construir lista de artículos
                    let articulosTxt = '';
                    if (orderData.items && orderData.items.length > 0) {
                        articulosTxt = orderData.items.map(it => `• *${it.cantidad}x* ${it.descripcion}`).join('\n');
                    } else {
                        articulosTxt = '_Sin artículos registrados en este folio._';
                    }

                    let responseMsg = `📦 *Detalle de Cotización PE${orderData.pedido}*\n\n`;

                    if (isOfflineFallback) {
                        responseMsg += `⚠️ *Nota:* Mostrando información de la caché local debido a mantenimiento técnico.\n\n`;
                    }

                    responseMsg += `👤 *Cliente:* ${orderData.cliente}\n`;
                    responseMsg += `📅 *Fecha:* ${fechaFormat}\n`;
                    responseMsg += `📌 *Estado:* ${estadoDecorado}\n\n`;

                    responseMsg += `💵 *Resumen Financiero:*\n`;
                    responseMsg += `• Subtotal: $${(orderData.importe).toFixed(2)}\n`;
                    responseMsg += `• I.V.A.: $${(orderData.impuesto).toFixed(2)}\n`;
                    responseMsg += `• *TOTAL NETO:* $${(orderData.total).toFixed(2)}\n\n`;

                    responseMsg += `📋 *Artículos:*\n${articulosTxt}\n`;
                    responseMsg += guiaCaja + `\n\n_Gracias por cotizar con Lopez Impresores._`;

                    reply(responseMsg);
                } else {
                    reply(`🔍 No encontré ningún pedido o cotización con el folio *PE${pedidoId}*.\n\nPor favor, verifica que el número sea correcto.`);
                }
            } catch (err) {
                console.error(`Error en consulta de pedido PE${pedidoId}:`, err);
                reply(`❌ Ocurrió un error al consultar el folio *PE${pedidoId}*. Por favor, inténtalo de nuevo más tarde.`);
            }
            return responses;
        }

        // 1. Verificar si el usuario existe
        let user = dryRun ? simulatedUser : await getUser(identifier);


        if (!user) {
            if (session.state !== 'ASKING_NAME') {
                session.state = 'ASKING_NAME';
                await handlePromotions('WELCOME');
                const welcomeText = `¡Hola! Bienvenido a *Lopez Impresores*.\n🌐 https://lopezimpresores.mx/\n📞 (755) 554-2478 y 554-2578\n✉️ ventas@lopezimpresores.mx\n\nPara comenzar y proporcionarte un mejor servicio, ¿me podrías decir tu nombre y apellido?`;
                replyWithLogo(welcomeText);
                return responses;
            } else {
                // Si el bot está pidiendo el nombre y el usuario envía un saludo genérico,
                // le recordamos que necesitamos su nombre y no cambiamos el estado.
                const genericPhrases = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos', 'ok', 'gracias', 'gracias!'];
                if (genericPhrases.includes(textLower)) {
                    reply(`¡Hola! Necesito tu nombre y apellido para poder registrarte y ofrecerte un mejor servicio. Por favor, escríbelos.`);
                    return responses;
                }

                if (!dryRun) {
                    await createUser(identifier, textMessage);
                } else {
                    // En dryRun guardamos el usuario solo en memoria
                    session.simulatedUser = { phone: identifier, name: textMessage };
                }
                session.state = 'IDLE';
                await handlePromotions('POST_NAME');
                reply(`¡Gracias, ${textMessage}! Ya te hemos registrado.\n\n¿Qué artículo deseas buscar o cotizar? Escribe el nombre o parte del nombre.`);
                return responses;
            }
        }

        // ─── COMANDOS DE COTIZACIÓN INTERACTIVA ────────────────────────────────

        // 1. Ver resumen de cotización actual
        if (/^(?:ver\s*cotizaci[oó]n|cotizaci[oó]n|resumen|ver|lista)$/i.test(textLower)) {
            console.log(`[BOT-EDIT] ${identifier} solicitó ver resumen de cotización.`);
            const summary = await formatQuoteSummary(identifier, dryRun ? session.simulatedQuote : null);
            reply(summary);
            return responses;
        }

        // 2. Eliminar un producto por su número
        const deleteMatch = textLower.match(/^(?:eliminar|quitar|borrar|del|rm)\s*(\d+)$/i);
        if (deleteMatch) {
            const idx = parseInt(deleteMatch[1], 10);
            const pending = dryRun ? (session.simulatedQuote || []) : await getPendingQuote(identifier);

            console.log(`[BOT-EDIT] ${identifier} intentó eliminar artículo #${idx} de su cotización.`);

            if (idx < 1 || idx > pending.length) {
                reply(`❌ Número inválido. Por favor selecciona un número de artículo entre 1 y ${pending.length}.`);
                return responses;
            }

            const itemToDelete = pending[idx - 1];

            if (dryRun) {
                session.simulatedQuote.splice(idx - 1, 1);
            } else {
                await deleteQuoteDetailById(itemToDelete.id);
            }

            reply(`🗑️ Se ha eliminado *${itemToDelete.descrip}* de tu cotización.`);

            const summary = await formatQuoteSummary(identifier, dryRun ? session.simulatedQuote : null);
            reply(summary);
            return responses;
        }

        // 3. Cambiar cantidad de un producto por su número
        const changeQtyRegex1 = /^(?:cambiar|modificar|cantidad|set)\s+(\d+)\s*(?:a|to|=|\s)\s*(\d+)$/i;
        const changeQtyRegex2 = /^(\d+)\s*(?:a|to|=)\s*(\d+)$/i;
        const quantityMatch = textLower.match(changeQtyRegex1) || textLower.match(changeQtyRegex2);

        if (quantityMatch) {
            const idx = parseInt(quantityMatch[1], 10);
            const newQty = parseInt(quantityMatch[2], 10);
            const pending = dryRun ? (session.simulatedQuote || []) : await getPendingQuote(identifier);

            console.log(`[BOT-EDIT] ${identifier} intentó cambiar cantidad del artículo #${idx} a ${newQty}.`);

            if (idx < 1 || idx > pending.length) {
                reply(`❌ Número inválido. Por favor selecciona un número de artículo entre 1 y ${pending.length}.`);
                return responses;
            }

            if (isNaN(newQty) || newQty <= 0) {
                reply(`❌ Por favor ingresa una cantidad válida mayor a 0.`);
                return responses;
            }

            const itemToUpdate = pending[idx - 1];

            // Recalcular precio según umbrales si es posible
            try {
                // Determinar impuesto (puede venir en minúsculas desde SQLite)
                // No asumir 'IVA' por defecto: si el campo es null/undefined, respetar exención
                const impuesto = itemToUpdate.impuesto ?? itemToUpdate.IMPUESTO ?? null;

                // Intentar obtener el producto para acceder a PRECIO/C umbrales
                const prod = await getProductByArticulo(itemToUpdate.articulo);

                let precioBase = itemToUpdate.precio_unitario;
                if (prod) {
                    const { price } = selectPriceByQuantity(prod, newQty);
                    precioBase = price;
                }

                const { totalUnitario, montoIva } = calcularIva(precioBase, impuesto);

                if (dryRun) {
                    itemToUpdate.cantidad = newQty;
                    itemToUpdate.precio_unitario = precioBase;
                    itemToUpdate.monto_iva = montoIva;
                    itemToUpdate.total_unitario = totalUnitario;
                } else {
                    await updateQuoteDetailPriceById(itemToUpdate.id, newQty, precioBase, montoIva, totalUnitario);
                }

                reply(`✏️ Se actualizó la cantidad de *${itemToUpdate.descrip}* a *${newQty}*.`);
            } catch (err) {
                console.error('Error al recalcular precio al cambiar cantidad:', err);
                // Fallback: solo actualizar cantidad
                if (dryRun) {
                    itemToUpdate.cantidad = newQty;
                } else {
                    await updateQuoteDetailQuantityById(itemToUpdate.id, newQty);
                }
                reply(`✏️ Se actualizó la cantidad de *${itemToUpdate.descrip}* a *${newQty}*.`);
            }

            const summary = await formatQuoteSummary(identifier, dryRun ? session.simulatedQuote : null);
            reply(summary);
            return responses;
        }

        // Finalizar cotización
        if (['terminar', 'fin', 'cotizar'].includes(textLower)) {
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
                        console.warn('⚠️ MS SQL offline al finalizar cotización. Se sincronizará después.', sqlErr.message);
                        await saveLog('WARN', 'bot', `MS SQL offline al finalizar cotización de ${user.name}`, sqlErr);
                    }

                    // Finalizar en SQLite — synced=1 si se creó en SQL, synced=0 si no
                    await finalizeQuote(identifier, pedidoId);
                } else {
                    session.simulatedQuote = [];
                }

                const pdfPath = await generateQuotePdf(user, pending, pedidoId);

                let orderMsg = `¡Listo, ${user.name}! Aquí tienes tu cotización en PDF.\n\n¡Gracias por cotizar con nosotros!`;
                if (pedidoId) {
                    orderMsg += `\n\n✅ Cotización registrada en nuestro sistema con el número: *${pedidoId}*`;
                }

                replyPdf(pdfPath, orderMsg);

            } catch (err) {
                console.error('Error generando PDF:', err);
                await saveLog('ERROR', 'pdf', `Error generando PDF para ${user.name}`, err);
                reply('Hubo un error al generar el PDF. Por favor intenta de nuevo.');
            }

            session.state = 'IDLE';
            session.selectedItem = null;
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
            session.selectionQueue = [];
            await handlePromotions('WELCOME');
            replyWithLogo(`Hasta luego ${user.name} 👋\n\nGracias por contactar a *Lopez Impresores*.\nRecuerda que estamos en:\n🌐 https://lopezimpresores.mx/\n📞 (755) 554-2478 y 554-2578\n✉️ ventas@lopezimpresores.mx\n\nEstamos pendientes para asesorarte con otra cotización o información. ¡Que tengas un excelente día! 😊`);
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

            await handlePromotions('WELCOME');

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

            await executeProductSearch(textMessage, session, responses);

        } else if (session.state === 'SELECTING_ITEM') {
            const num = parseInt(textMessage.trim(), 10);

            // 0 = ver más resultados
            if (num === 0) {
                const nextStart = (session.searchPage + 1) * PAGE_SIZE;
                if (nextStart >= session.allResults.length) {
                    reply('Ya estás viendo todos los resultados. Escribe el número del artículo que deseas.');
                } else {
                    session.searchPage += 1;
                    reply(buildResultsPage(session));
                }

                // Detectar selección múltiple o simple (ej. "1, 4, 8" o "1 y 4")
            } else if (/^[0-9\s,y\-]+$/i.test(textMessage.trim())) {
                const numbers = textMessage.match(/\d+/g);
                const indices = numbers ? numbers.map(n => parseInt(n, 10)) : [];
                const validIndices = indices.filter(n => n > 0 && n <= session.searchResults.length);

                if (validIndices.length > 0) {
                    // Cargar selección en la cola
                    session.selectionQueue = validIndices.map(idx => session.searchResults[idx - 1]);
                    // Tomar el primer artículo de la cola
                    session.selectedItem = session.selectionQueue.shift();
                    session.state = 'ASKING_QUANTITY';

                    reply(`Has seleccionado: *${session.selectedItem.DESCRIP}*\n\n¿Qué *cantidad* deseas agregar? (Escribe un número)`);
                } else {
                    reply('Los números seleccionados no se encuentran en la lista actual de resultados. Intenta de nuevo o escribe otra palabra para buscar.');
                }

                // No es número válido → nueva búsqueda
            } else {
                await executeProductSearch(textMessage, session, responses);
            }

        } else if (session.state === 'ASKING_QUANTITY') {
            const cantidad = parseInt(textMessage, 10);

                if (!isNaN(cantidad) && cantidad > 0) {
                    const item = session.selectedItem;

                    // Seleccionar precio según cantidad (PRECIO1..PRECIO10 y umbrales C2..C10)
                    const { price: precioBase, priceLevel, matchedC, matchedIndex } = selectPriceByQuantity(item, cantidad);
                    const { totalUnitario, montoIva } = calcularIva(precioBase, item.IMPUESTO);

                    // Mostrar en consola el precio y el nivel usado (no persistir en DB)
                    try {
                        const cInfo = matchedC ? `umbral C${matchedIndex}=${matchedC}` : 'sin umbral (PRECIO1)';
                        console.log(`[PRICING] Artículo ${item.ARTICULO} - qty=${cantidad} -> precio=${precioBase} (${priceLevel}), ${cInfo}`);
                    } catch (logErr) {
                        console.error('[PRICING] Error imprimiendo log de pricing:', logErr);
                    }

                    if (!dryRun) {
                        // Si es el primer ítem que agrega, mostrar promo PRE_QUOTE
                        const pending = await getPendingQuote(identifier);
                        if (pending.length === 0) {
                            await handlePromotions('PRE_QUOTE');
                        }
                        await addItemToQuote(identifier, item.ARTICULO, item.DESCRIP, cantidad, precioBase, montoIva, totalUnitario, item.IMPUESTO);
                    } else {
                        // Acumular ítems en memoria para poder generar el PDF de prueba
                        if (!session.simulatedQuote) session.simulatedQuote = [];
                        session.simulatedQuote.push({
                            articulo: item.ARTICULO,
                            descrip: item.DESCRIP,
                            cantidad,
                            precio_unitario: precioBase,
                            monto_iva: montoIva,
                            total_unitario: totalUnitario,
                            impuesto: item.IMPUESTO
                        });
                    }


                // Si hay más elementos en la cola
                if (session.selectionQueue && session.selectionQueue.length > 0) {
                    session.selectedItem = session.selectionQueue.shift();
                    // Permanecemos en el estado ASKING_QUANTITY
                    reply(`✅ Se agregó *${cantidad}x ${item.DESCRIP}* a tu cotización.\n\nSiguiente artículo seleccionado: *${session.selectedItem.DESCRIP}*\n¿Qué *cantidad* deseas agregar? (Escribe un número)`);
                } else {
                    // Fin de la cola
                    session.state = 'IDLE';
                    session.selectedItem = null;
                    session.searchResults = [];
                    session.selectionQueue = [];

                    const summary = await formatQuoteSummary(identifier, dryRun ? session.simulatedQuote : null);
                    reply(`✅ Se agregaron tus artículos seleccionados a la cotización.\n\n${summary}`);
                }
            } else {
                reply(`❌ Cantidad inválida. Si deseas agregar *${session.selectedItem.DESCRIP}*, por favor, escribe un número mayor a 0.\n\nSi quieres buscar otro artículo, simplemente escríbelo.`);
            }
        }

    } catch (error) {
        console.error('Error en el flujo del bot:', error);
        await saveLog('ERROR', 'bot', `Error en flujo para ${identifier}: ${error.message}`, error);
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
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`[BOT-CONN] Conexión cerrada. Código de estado: ${statusCode || 'desconocido'}`);

            if (isLoggedOut) {
                console.log('🚪 [BOT-CONN] Sesión desvinculada por el usuario o revocada. Limpiando credenciales antiguas...');
                botState.hasConnected = false;

                try {
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                        console.log('🧹 [BOT-CONN] Credenciales en disco eliminadas correctamente.');
                    }
                } catch (err) {
                    console.error('❌ [BOT-CONN] Error al eliminar la carpeta de sesión:', err.message);
                }

                console.log('🔄 [BOT-CONN] Reiniciando motor en 3 segundos para generar nuevo código QR...');
                setTimeout(startBot, 3000);
            } else {
                console.log('🔌 [BOT-CONN] Error de conexión o reinicio de red. Intentando reconectar en 5 segundos...');
                setTimeout(startBot, 5000);
            }
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
