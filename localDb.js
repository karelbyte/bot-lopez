const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let dbPromise = null;

async function getLocalDb() {
    if (!dbPromise) {
        dbPromise = open({
            filename: './local_bot.db',
            driver: sqlite3.Database
        }).then(async (db) => {
            // Activar Foreign Keys en SQLite
            await db.exec('PRAGMA foreign_keys = ON;');
            
            // Crear tablas normalizadas
            await db.exec(`
                CREATE TABLE IF NOT EXISTS clients (
                    phone TEXT PRIMARY KEY,
                    name TEXT,
                    cliente_id TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS quotes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_phone TEXT,
                    sql_pedido_id INTEGER,
                    status TEXT DEFAULT 'pending',
                    synced INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (client_phone) REFERENCES clients(phone)
                );

                CREATE TABLE IF NOT EXISTS quote_details (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    quote_id INTEGER,
                    articulo TEXT,
                    descrip TEXT,
                    cantidad INTEGER,
                    precio_unitario REAL,
                    monto_iva REAL,
                    total_unitario REAL,
                    impuesto TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS promotions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    position TEXT,
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS campaigns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    level TEXT NOT NULL,
                    source TEXT NOT NULL,
                    message TEXT NOT NULL,
                    detail TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS products (
                    articulo TEXT PRIMARY KEY,
                    descrip TEXT NOT NULL,
                    precio1 REAL NOT NULL,
                    impuesto TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Migraciones: agregar columnas nuevas a tablas existentes si no existen
            const migrations = [
                "ALTER TABLE quotes ADD COLUMN synced INTEGER DEFAULT 0",
                "ALTER TABLE quotes ADD COLUMN sql_pedido_id INTEGER",
                "ALTER TABLE quote_details ADD COLUMN cantidad INTEGER",
                "ALTER TABLE quote_details ADD COLUMN precio_unitario REAL",
                "ALTER TABLE quote_details ADD COLUMN monto_iva REAL",
                "ALTER TABLE quote_details ADD COLUMN total_unitario REAL",
                "ALTER TABLE quote_details ADD COLUMN impuesto TEXT",
            ];
            for (const migration of migrations) {
                try {
                    await db.exec(migration);
                } catch (e) {
                    // Ignorar error "duplicate column" — significa que ya existe
                }
            }

            return db;
        });
    }
    return dbPromise;
}

// ========================
// Módulo de Clientes
// ========================
async function getUser(phone) {
    const db = await getLocalDb();
    return db.get('SELECT * FROM clients WHERE phone = ?', [phone]);
}

async function getAllClients() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM clients');
}

async function createUser(phone, name) {
    const db = await getLocalDb();
    await db.run('INSERT OR REPLACE INTO clients (phone, name) VALUES (?, ?)', [phone, name]);
}

async function updateUserCode(phone, code) {
    const db = await getLocalDb();
    await db.run('UPDATE clients SET cliente_id = ? WHERE phone = ?', [code, phone]);
}

// ========================
// Módulo de Cotizaciones
// ========================

// Obtener la cotización pendiente actual del cliente
async function getActiveQuoteId(db, phone) {
    const quote = await db.get('SELECT id FROM quotes WHERE client_phone = ? AND status = "pending"', [phone]);
    return quote ? quote.id : null;
}

// Agregar un artículo a la cotización (crea la cabecera si no existe)
async function addItemToQuote(phone, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto) {
    const db = await getLocalDb();
    
    let quoteId = await getActiveQuoteId(db, phone);
    
    if (!quoteId) {
        const result = await db.run('INSERT INTO quotes (client_phone, status) VALUES (?, "pending")', [phone]);
        quoteId = result.lastID;
    }

    await db.run(
        'INSERT INTO quote_details (quote_id, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [quoteId, articulo, descrip, cantidad, precio_unitario, monto_iva, total_unitario, impuesto]
    );
}

// Obtener todos los detalles de la cotización pendiente
async function getPendingQuote(phone) {
    const db = await getLocalDb();
    const quoteId = await getActiveQuoteId(db, phone);
    
    if (!quoteId) return [];

    return db.all('SELECT * FROM quote_details WHERE quote_id = ?', [quoteId]);
}

// Borrar la cotización pendiente (Cascada borra los detalles)
async function clearPendingQuote(phone) {
    const db = await getLocalDb();
    await db.run('DELETE FROM quotes WHERE client_phone = ? AND status = "pending"', [phone]);
}

// Finalizar la cotización (Cambia estado de la cabecera y guarda el ID de SQL)
async function finalizeQuote(phone, sqlPedidoId = null) {
    const db = await getLocalDb();
    const synced = sqlPedidoId ? 1 : 0;
    await db.run(
        'UPDATE quotes SET status = "finalized", sql_pedido_id = ?, synced = ? WHERE client_phone = ? AND status = "pending"',
        [sqlPedidoId, synced, phone]
    );
}

// Obtener todas las cotizaciones finalizadas con datos del cliente
async function getAllQuotes() {
    const db = await getLocalDb();
    return db.all(`
        SELECT q.id, q.status, q.synced, q.sql_pedido_id, q.created_at,
               c.name as client_name, c.phone as client_phone
        FROM quotes q
        JOIN clients c ON c.phone = q.client_phone
        WHERE q.status = 'finalized'
        ORDER BY q.created_at DESC
    `);
}

// Obtener cotizaciones finalizadas que no se pudieron sincronizar con MS SQL
async function getUnsyncedQuotes() {
    const db = await getLocalDb();
    return db.all(`
        SELECT q.id, q.client_phone, q.created_at,
               c.name as client_name
        FROM quotes q
        JOIN clients c ON c.phone = q.client_phone
        WHERE q.status = 'finalized' AND q.synced = 0
        ORDER BY q.created_at ASC
    `);
}

// Obtener detalles de una cotización por su ID
async function getQuoteDetailsById(quoteId) {
    const db = await getLocalDb();
    return db.all('SELECT * FROM quote_details WHERE quote_id = ?', [quoteId]);
}

// Marcar una cotización como sincronizada con MS SQL
async function markQuoteSynced(quoteId, sqlPedidoId) {
    const db = await getLocalDb();
    await db.run(
        'UPDATE quotes SET synced = 1, sql_pedido_id = ? WHERE id = ?',
        [sqlPedidoId, quoteId]
    );
}

// ========================
// Módulo de Promociones
// ========================

async function getActivePromotions(position) {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions WHERE position = ? AND active = 1', [position]);
}

async function getAllPromotions() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions ORDER BY created_at DESC');
}

async function addPromotion(text, image_url, position) {
    const db = await getLocalDb();
    await db.run('INSERT INTO promotions (text, image_url, position) VALUES (?, ?, ?)', [text, image_url, position]);
}

async function updatePromotion(id, active) {
    const db = await getLocalDb();
    await db.run('UPDATE promotions SET active = ? WHERE id = ?', [active, id]);
}

async function deletePromotion(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM promotions WHERE id = ?', [id]);
}

// ========================
// Módulo de Campañas
// ========================

async function addCampaign(text, image_url) {
    const db = await getLocalDb();
    await db.run('INSERT INTO campaigns (text, image_url) VALUES (?, ?)', [text, image_url]);
}

async function getAllCampaigns() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM campaigns ORDER BY created_at DESC');
}

async function deleteCampaign(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM campaigns WHERE id = ?', [id]);
}

// ========================
// Módulo de Analítica
// ========================

async function getAnalyticsStats() {
    const db = await getLocalDb();
    
    // Total de cotizaciones finalizadas
    const totalQuotes = await db.get('SELECT COUNT(*) as count FROM quotes WHERE status = "finalized"');
    
    // Productos más cotizados (Top 10)
    const topProducts = await db.all(`
        SELECT descrip, COUNT(*) as count 
        FROM quote_details 
        GROUP BY descrip 
        ORDER BY count DESC 
        LIMIT 10
    `);

    // Actividad diaria (últimos 7 días)
    const dailyActivity = await db.all(`
        SELECT DATE(created_at) as date, COUNT(*) as count 
        FROM quotes 
        WHERE status = "finalized" 
        GROUP BY DATE(created_at) 
        ORDER BY date DESC 
        LIMIT 7
    `);

    // Clientes únicos
    const totalClients = await db.get('SELECT COUNT(*) as count FROM clients');

    return {
        totalQuotes: totalQuotes.count,
        topProducts,
        dailyActivity: dailyActivity.reverse(),
        totalClients: totalClients.count
    };
}

// ========================
// Módulo de Productos (caché local)
// ========================

async function upsertProducts(products) {
    const db = await getLocalDb();
    const stmt = await db.prepare(
        `INSERT INTO products (articulo, descrip, precio1, impuesto, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(articulo) DO UPDATE SET
             descrip    = excluded.descrip,
             precio1    = excluded.precio1,
             impuesto   = excluded.impuesto,
             updated_at = CURRENT_TIMESTAMP`
    );
    for (const p of products) {
        await stmt.run(p.ARTICULO, p.DESCRIP, p.PRECIO1, p.IMPUESTO || null);
    }
    await stmt.finalize();
}

async function searchProductsLocal(searchTerm) {
    const db = await getLocalDb();
    const words = searchTerm.trim().split(/\s+/).filter(w => w.length > 0);
    const conditions = words.map(() => 'descrip LIKE ?').join(' AND ');
    const params = words.map(w => `%${w}%`);
    return db.all(
        `SELECT articulo as ARTICULO, descrip as DESCRIP, precio1 as PRECIO1, impuesto as IMPUESTO
         FROM products WHERE ${conditions} ORDER BY descrip`,
        params
    );
}

async function getProductsCount() {
    const db = await getLocalDb();
    const row = await db.get('SELECT COUNT(*) as count FROM products');
    return row ? row.count : 0;
}

// ========================
// Módulo de Logs
// ========================

async function saveLog(level, source, message, detail = null) {
    try {
        const db = await getLocalDb();
        const detailStr = detail instanceof Error
            ? (detail.stack || detail.message)
            : (detail ? String(detail) : null);
        await db.run(
            'INSERT INTO logs (level, source, message, detail) VALUES (?, ?, ?, ?)',
            [level, source, message, detailStr]
        );
    } catch (err) {
        // Fallback a consola si SQLite falla para no crear loop
        console.error('[LOG-SAVE-ERROR]', err.message);
    }
}

async function getLogs({ level, source, limit = 200 } = {}) {
    const db = await getLocalDb();
    let query = 'SELECT * FROM logs WHERE 1=1';
    const params = [];
    if (level) { query += ' AND level = ?'; params.push(level); }
    if (source) { query += ' AND source = ?'; params.push(source); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return db.all(query, params);
}

async function clearLogs(olderThanDays = 30) {
    const db = await getLocalDb();
    await db.run(
        "DELETE FROM logs WHERE created_at < datetime('now', ?)",
        [`-${olderThanDays} days`]
    );
}

async function deleteQuote(id) {
    const db = await getLocalDb();
    return db.run('DELETE FROM quotes WHERE id = ?', [id]);
}

async function getLocalPedidoStatus(sqlPedidoId) {
    try {
        const db = await getLocalDb();
        // 1. Obtener la cabecera de la cotización local por sql_pedido_id
        const quote = await db.get(`
            SELECT q.id, q.created_at, q.status, q.synced, q.sql_pedido_id, c.name as client_name
            FROM quotes q
            JOIN clients c ON c.phone = q.client_phone
            WHERE q.sql_pedido_id = ?
        `, [sqlPedidoId]);
        
        if (!quote) return null;
        
        // 2. Obtener los detalles de la cotización local
        const details = await db.all(`
            SELECT cantidad, descrip, precio_unitario, monto_iva, total_unitario
            FROM quote_details
            WHERE quote_id = ?
        `, [quote.id]);
        
        let subtotal = 0;
        let iva = 0;
        let total = 0;
        
        const items = details.map(d => {
            const qty = d.cantidad || 0;
            const price = d.precio_unitario || 0;
            const tax = d.monto_iva || 0;
            const unitTotal = d.total_unitario || 0;
            
            subtotal += price * qty;
            iva += tax * qty;
            total += unitTotal * qty;
            
            return {
                cantidad: qty,
                descripcion: d.descrip ? d.descrip.trim() : 'Sin descripción'
            };
        });
        
        return {
            pedido: quote.sql_pedido_id,
            fecha: quote.created_at,
            cliente: quote.client_name || 'Cliente local',
            importe: subtotal,
            impuesto: iva,
            total: total,
            estado: 'PE', // En caché local asumimos Cotizado / Pendiente de Caja (PE)
            items: items,
            isLocalCache: true
        };
    } catch (error) {
        console.error('Error al obtener status de pedido local:', error);
        return null;
    }
}

async function deleteQuoteDetailById(detailId) {
    try {
        const db = await getLocalDb();
        await db.run('DELETE FROM quote_details WHERE id = ?', [detailId]);
        console.log(`[DB-QUOTE] Detalle de cotización eliminado: ID ${detailId}`);
    } catch (err) {
        console.error(`Error al eliminar detalle de cotización ID ${detailId}:`, err);
        throw err;
    }
}

async function updateQuoteDetailQuantityById(detailId, quantity) {
    try {
        const db = await getLocalDb();
        await db.run('UPDATE quote_details SET cantidad = ? WHERE id = ?', [quantity, detailId]);
        console.log(`[DB-QUOTE] Cantidad de detalle de cotización actualizada: ID ${detailId} -> ${quantity}`);
    } catch (err) {
        console.error(`Error al actualizar cantidad de detalle de cotización ID ${detailId}:`, err);
        throw err;
    }
}

module.exports = {
    getLocalDb,
    getUser,
    createUser,
    updateUserCode,
    addItemToQuote,
    getPendingQuote,
    clearPendingQuote,
    finalizeQuote,
    getAllQuotes,
    getUnsyncedQuotes,
    getQuoteDetailsById,
    markQuoteSynced,
    deleteQuote,
    getActivePromotions,
    getAllPromotions,
    addPromotion,
    updatePromotion,
    deletePromotion,
    getAnalyticsStats,
    getAllClients,
    addCampaign,
    getAllCampaigns,
    deleteCampaign,
    upsertProducts,
    searchProductsLocal,
    getProductsCount,
    saveLog,
    getLogs,
    clearLogs,
    getLocalPedidoStatus,
    deleteQuoteDetailById,
    updateQuoteDetailQuantityById
};

