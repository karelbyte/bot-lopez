/**
 * syncTask.js
 * Tarea periódica que sincroniza cotizaciones pendientes con MS SQL.
 * Se ejecuta cada 5 minutos. Si MS SQL está offline, espera al siguiente ciclo.
 */

const { createSqlPedido, connectToDatabase } = require('./db.js');
const { getUnsyncedQuotes, getQuoteDetailsById, markQuoteSynced, saveLog } = require('./localDb.js');

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

async function isSqlOnline() {
    try {
        await connectToDatabase();
        return true;
    } catch {
        return false;
    }
}

async function syncPendingQuotes() {
    try {
        const online = await isSqlOnline();
        if (!online) {
            console.log('[SYNC] MS SQL offline. Se reintentará en el próximo ciclo.');
            return;
        }

        const unsyncedQuotes = await getUnsyncedQuotes();

        if (unsyncedQuotes.length === 0) {
            return; // Nada que sincronizar
        }

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
        await saveLog('ERROR', 'sync', 'Error general en tarea de sincronización', err);
    }
}

function startSyncTask() {
    console.log(`[SYNC] Tarea de sincronización iniciada (cada ${SYNC_INTERVAL_MS / 60000} minutos).`);

    // Ejecutar una vez al arrancar (por si quedaron pendientes de sesiones anteriores)
    syncPendingQuotes();

    // Luego cada 5 minutos
    setInterval(syncPendingQuotes, SYNC_INTERVAL_MS);
}

module.exports = { startSyncTask, syncPendingQuotes };
