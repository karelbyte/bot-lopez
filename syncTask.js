/**
 * syncTask.js
 * - Sincroniza cotizaciones pendientes con MS SQL cada 5 minutos.
 * - Sincroniza el catálogo de productos de MS SQL → SQLite todos los días a las 10:00 AM.
 */

const { createSqlPedido, connectToDatabase } = require('./db.js');
const { getUnsyncedQuotes, getQuoteDetailsById, markQuoteSynced, saveLog, upsertProducts, getProductsCount } = require('./localDb.js');

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const PRODUCT_SYNC_HOUR = 10;            // 10:00 AM

async function isSqlOnline() {
    try {
        await connectToDatabase();
        return true;
    } catch {
        return false;
    }
}

// ─── Sync de cotizaciones pendientes ─────────────────────────────────────────
async function syncPendingQuotes() {
    try {
        const online = await isSqlOnline();
        if (!online) {
            console.log('[SYNC] MS SQL offline. Se reintentará en el próximo ciclo.');
            return;
        }

        const unsyncedQuotes = await getUnsyncedQuotes();
        if (unsyncedQuotes.length === 0) return;

        console.log(`[SYNC] ${unsyncedQuotes.length} cotización(es) pendiente(s) de sincronizar.`);

        for (const quote of unsyncedQuotes) {
            try {
                const items = await getQuoteDetailsById(quote.id);

                if (items.length === 0) {
                    console.warn(`[SYNC] Cotización ${quote.id} sin ítems, marcando como sincronizada.`);
                    await saveLog('WARN', 'sync', `Cotización #${quote.id} sin ítems, marcada como sincronizada`);
                    await markQuoteSynced(quote.id, null);
                    continue;
                }

                const pedidoId = await createSqlPedido(items, quote.client_name);
                await markQuoteSynced(quote.id, pedidoId);
                await saveLog('INFO', 'sync', `Cotización #${quote.id} (${quote.client_name}) sincronizada → Pedido MS SQL #${pedidoId}`);
                console.log(`[SYNC] ✅ Cotización ${quote.id} (${quote.client_name}) sincronizada → Pedido MS SQL #${pedidoId}`);

            } catch (err) {
                console.error(`[SYNC] ❌ Error sincronizando cotización ${quote.id}:`, err.message);
                await saveLog('ERROR', 'sync', `Error sincronizando cotización #${quote.id} (${quote.client_name})`, err);
            }
        }

    } catch (err) {
        console.error('[SYNC] Error general en syncPendingQuotes:', err.message);
        await saveLog('ERROR', 'sync', 'Error general en tarea de sincronización de cotizaciones', err);
    }
}

// ─── Sync de catálogo de productos ───────────────────────────────────────────
async function syncProducts() {
    console.log('[PRODUCTS] Iniciando sincronización de catálogo desde MS SQL...');
    try {
        const online = await isSqlOnline();
        if (!online) {
            console.warn('[PRODUCTS] MS SQL offline. No se puede sincronizar catálogo.');
            await saveLog('WARN', 'sync', 'Sync de productos omitida: MS SQL offline');
            return;
        }

        const pool = await connectToDatabase();
        const result = await pool.request().query(`
            SELECT [ARTICULO], [DESCRIP], [PRECIO1], [PRECIO2], [PRECIO3], [PRECIO4], [PRECIO5], [PRECIO6], [PRECIO7], [PRECIO8], [PRECIO9], [PRECIO10], [IMPUESTO], [C2], [C3], [C4], [C5], [C6], [C7], [C8], [C9], [C10]
            FROM prods
            ORDER BY [DESCRIP]
        `);

        const products = result.recordset;
        if (products.length === 0) {
            await saveLog('WARN', 'sync', 'Sync de productos: MS SQL devolvió 0 productos');
            return;
        }

        await upsertProducts(products);

        const total = await getProductsCount();
        const msg = `Catálogo sincronizado: ${products.length} productos procesados (${total} en caché local)`;
        console.log(`[PRODUCTS] ✅ ${msg}`);
        await saveLog('INFO', 'sync', msg);

    } catch (err) {
        console.error('[PRODUCTS] ❌ Error sincronizando catálogo:', err.message);
        await saveLog('ERROR', 'sync', 'Error en sincronización de catálogo de productos', err);
    }
}

// ─── Scheduler diario a las 10:00 AM ─────────────────────────────────────────
function scheduleProductSync() {
    function msUntilNextRun() {
        const now = new Date();
        const next = new Date();
        next.setHours(PRODUCT_SYNC_HOUR, 0, 0, 0);
        if (next <= now) {
            next.setDate(next.getDate() + 1); // Si ya pasó hoy, programar para mañana
        }
        return next - now;
    }

    function scheduleNext() {
        const ms = msUntilNextRun();
        const nextRun = new Date(Date.now() + ms);
        console.log(`[PRODUCTS] Próxima sincronización de catálogo: ${nextRun.toLocaleString('es-MX')}`);
        setTimeout(async () => {
            await syncProducts();
            scheduleNext(); // Reprogramar para el día siguiente
        }, ms);
    }

    scheduleNext();
}

// ─── Arranque ─────────────────────────────────────────────────────────────────
function startSyncTask() {
    console.log(`[SYNC] Tarea de cotizaciones iniciada (cada ${SYNC_INTERVAL_MS / 60000} minutos).`);
    syncPendingQuotes();
    setInterval(syncPendingQuotes, SYNC_INTERVAL_MS);

    // Programar sync de productos a las 10:00 AM diario
    scheduleProductSync();
}

module.exports = { startSyncTask, syncPendingQuotes, syncProducts };
