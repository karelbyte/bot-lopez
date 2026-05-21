require('dotenv').config();
const sql = require('mssql');
const { saveLog, searchProductsLocal } = require('./localDb.js');

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT || '1433', 10),
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

let poolPromise = null;

async function connectToDatabase() {
    if (poolPromise) {
        return poolPromise;
    }
    
    try {
        console.log('Conectando a MS SQL Express...');
        poolPromise = await sql.connect(dbConfig);
        console.log('✅ Conexión a la base de datos establecida.');
        return poolPromise;
    } catch (err) {
        console.error('❌ Error al conectar a la base de datos:', err);
        poolPromise = null;
        // saveLog sin await para no bloquear — y evitar dependencia circular en el arranque
        saveLog('ERROR', 'db', 'Error de conexión a MS SQL', err).catch(() => {});
        throw err;
    }
}

async function query(queryString) {
    try {
        const pool = await connectToDatabase();
        const result = await pool.request().query(queryString);
        return result.recordset;
    } catch (err) {
        console.error('Error ejecutando query:', err);
        throw err;
    }
}

async function searchProducts(searchTerm) {
    try {
        const pool = await connectToDatabase();
        const words = searchTerm.trim().split(/\s+/).filter(w => w.length > 0);
        const request = pool.request();
        const conditions = words.map((word, i) => {
            request.input(`term${i}`, sql.VarChar, `%${word}%`);
            return `[DESCRIP] LIKE @term${i} COLLATE Latin1_General_CI_AI`;
        });
        const result = await request.query(`
            SELECT [ARTICULO], [DESCRIP], [PRECIO1], [IMPUESTO]
            FROM prods
            WHERE ${conditions.join(' AND ')}
            ORDER BY [DESCRIP]
        `);
        return result.recordset;
    } catch (err) {
        // MS SQL offline — usar caché local de SQLite
        console.warn('[DB] MS SQL no disponible para búsqueda, usando caché local.');
        await saveLog('WARN', 'db', `MS SQL offline en búsqueda "${searchTerm}", usando caché local`, err).catch(() => {});
        return searchProductsLocal(searchTerm);
    }
}

async function createSqlClient(nombre) {
    try {
        const pool = await connectToDatabase();
        const rfc = 'XAXX010101000';
        const cp = '40890';
        
        // Verificamos si el cliente ya existe para evitar duplicados
        const check = await pool.request()
            .input('nombre', sql.VarChar, nombre)
            .query(`SELECT [cliente], [NOMBRE] FROM clients WHERE [NOMBRE] = @nombre`);
            
        if (check.recordset.length > 0) {
            return check.recordset[0].cliente;
        }

        // Obtener el código de cliente más grande y sumarle 1
        const maxCodeResult = await pool.request().query(`
            SELECT MAX(TRY_CAST([cliente] AS INT)) as MaxCodigo FROM clients
        `);
        
        let nextCode = 1;
        if (maxCodeResult.recordset.length > 0 && maxCodeResult.recordset[0].MaxCodigo !== null) {
            nextCode = maxCodeResult.recordset[0].MaxCodigo + 1;
        }

        // Formatear el código a 6 dígitos (modificado por el usuario)
        const clienteCodigo = String(nextCode).padStart(6, '0');

        await pool.request()
            .input('cliente', sql.VarChar, clienteCodigo)
            .input('nombre', sql.VarChar, nombre)
            .input('rfc', sql.VarChar, rfc)
            .input('cp', sql.VarChar, cp)
            .query(`
                INSERT INTO clients ([cliente], [NOMBRE], [RFC], [CP], [PAIS])
                VALUES (@cliente, @nombre, @rfc, @cp, 'MÉXICO')
            `);
        console.log(`✅ Cliente ${nombre} agregado a la tabla clients de SQL con código ${clienteCodigo}.`);
        return clienteCodigo;
    } catch (err) {
        console.error('Error al crear cliente en SQL:', err);
        return null;
    }
}

async function createSqlPedido(items, clientName) {
    let transaction;
    try {
        const pool = await connectToDatabase();
        transaction = new sql.Transaction(pool);
        await transaction.begin();

        const now = new Date();
        const usuFecha = now;
        const usuHora = now.toTimeString().split(' ')[0].substring(0, 8); // HH:mm:ss

        const entrega = new Date();
        entrega.setDate(entrega.getDate() + 1);

        // Calcular totales
        let importeTotal = 0;
        let impuestoTotal = 0;
        items.forEach(it => {
            // MyBusiness suele usar importe sin impuesto en el encabezado
            importeTotal += it.precio_unitario * it.cantidad;
            impuestoTotal += it.monto_iva * it.cantidad;
        });

        // 1. Insertar encabezado en pedidos
        const requestPedido = new sql.Request(transaction);
        requestPedido.input('F_EMISION', sql.DateTime, usuFecha);
        requestPedido.input('CLIENTE', sql.NVarChar, 'SYS');
        requestPedido.input('VEND', sql.NVarChar, 'SYS');
        requestPedido.input('IMPORTE', sql.Float, importeTotal);
        requestPedido.input('IMPUESTO', sql.Float, impuestoTotal);
        requestPedido.input('ESTADO', sql.NVarChar, 'PE');
        requestPedido.input('MONEDA', sql.NVarChar, 'MXN');
        requestPedido.input('PRECIO', sql.NVarChar, '1');
        requestPedido.input('USUARIO', sql.NVarChar, 'BOT');
        requestPedido.input('USUFECHA', sql.DateTime, usuFecha);
        requestPedido.input('USUHORA', sql.NVarChar, usuHora);
        requestPedido.input('ALMACEN', sql.Int, 1);
        requestPedido.input('DATOS', sql.VarChar, clientName);
        requestPedido.input('COSTO', sql.Float, 0);
        requestPedido.input('TIPO_CAM', sql.Float, 1);
        requestPedido.input('DESCUENTO', sql.Float, 0);
        requestPedido.input('DESC1', sql.Float, 0);
        requestPedido.input('DESC2', sql.Float, 0);
        requestPedido.input('DESC3', sql.Float, 0);
        requestPedido.input('DESC4', sql.Float, 0);
        requestPedido.input('DESC5', sql.Float, 0);
        requestPedido.input('DESGLOSE', sql.SmallInt, 1);
        requestPedido.input('PEDCLI', sql.NVarChar, '0');
        requestPedido.input('APLICARDES', sql.SmallInt, 0);
        requestPedido.input('TIPO', sql.NVarChar, 'PE');
        requestPedido.input('DONATIVO', sql.SmallInt, 0);
        requestPedido.input('RELACION', sql.NVarChar, '(Al mismo)');
        requestPedido.input('ENTREGA', sql.DateTime, entrega);

        const resultPedido = await requestPedido.query(`
            INSERT INTO pedidos (F_EMISION, CLIENTE, VEND, IMPORTE, IMPUESTO, ESTADO, MONEDA, PRECIO, USUARIO, USUFECHA, USUHORA, ALMACEN, DATOS, COSTO, TIPO_CAM, DESCUENTO, DESC1, DESC2, DESC3, DESC4, DESC5, DESGLOSE, PEDCLI, AplicarDes, Tipo, donativo, RELACION, Entrega, ocupado)
            VALUES (@F_EMISION, @CLIENTE, @VEND, @IMPORTE, @IMPUESTO, @ESTADO, @MONEDA, @PRECIO, @USUARIO, @USUFECHA, @USUHORA, @ALMACEN, @DATOS, @COSTO, @TIPO_CAM, @DESCUENTO, @DESC1, @DESC2, @DESC3, @DESC4, @DESC5, @DESGLOSE, @PEDCLI, @APLICARDES, @TIPO, @DONATIVO, @RELACION, @ENTREGA, 0);
            
            DECLARE @NewPedidoId INT = SCOPE_IDENTITY();
            
            -- Sincronizamos no_ped y PEDCLI con el ID generado para mantener la consistencia que usa MyBusiness
            UPDATE pedidos SET no_ped = @NewPedidoId, PEDCLI = CAST(@NewPedidoId AS NVARCHAR(40)) WHERE pedido = @NewPedidoId;
            
            SELECT @NewPedidoId as pedidoId;
        `);

        const pedidoId = resultPedido.recordset[0].pedidoId;

        // 2. Insertar partidas en pedpar
        for (const it of items) {
            const requestPartida = new sql.Request(transaction);
            requestPartida.input('pedido', sql.Int, pedidoId);
            requestPartida.input('ARTICULO', sql.NVarChar, it.articulo);
            requestPartida.input('CANTIDAD', sql.Float, it.cantidad);
            requestPartida.input('PRECIO', sql.Float, it.precio_unitario);
            // MyBusiness suele esperar el porcentaje en el campo impuesto de la partida
            const porcentajeIva = it.impuesto === 'IVA' ? 16 : 0;
            requestPartida.input('IMPUESTO', sql.Real, porcentajeIva);
            requestPartida.input('DESCUENTO', sql.Float, 0);
            requestPartida.input('OBSERV', sql.NVarChar, it.descrip);
            requestPartida.input('USUARIO', sql.NVarChar, 'BOT');
            requestPartida.input('USUFECHA', sql.DateTime, usuFecha);
            requestPartida.input('USUHORA', sql.NVarChar, usuHora);
            requestPartida.input('ALMACEN', sql.Int, 1);
            requestPartida.input('LISTA', sql.Int, 1);
            requestPartida.input('CLAVE', sql.NVarChar, '');
            requestPartida.input('PRCANTIDAD', sql.Int, 0);
            requestPartida.input('DONATIVO', sql.SmallInt, 0);
            // PRDESCRIP tiene límite de 40 caracteres en pedpar
            requestPartida.input('PRDESCRIP', sql.NVarChar, it.descrip.substring(0, 40));

            await requestPartida.query(`
                INSERT INTO pedpar (pedido, ARTICULO, CANTIDAD, SURTIDO, POR_SURT, PRECIO, IMPUESTO, DESCUENTO, OBSERV, Usuario, UsuFecha, UsuHora, Almacen, Lista, Clave, PRCANTIDAD, donativo, PRDESCRIP)
                VALUES (@pedido, @ARTICULO, @CANTIDAD, 0, @CANTIDAD, @PRECIO, @IMPUESTO, @DESCUENTO, @OBSERV, @USUARIO, @USUFECHA, @USUHORA, @ALMACEN, @LISTA, @CLAVE, @PRCANTIDAD, @DONATIVO, @PRDESCRIP)
            `);
        }

        await transaction.commit();
        return pedidoId;

    } catch (err) {
        if (transaction) await transaction.rollback();
        console.error('Error al crear pedido en SQL:', err);
        throw err;
    }
}

async function deleteSqlPedido(pedidoId) {
    let transaction;
    try {
        const pool = await connectToDatabase();
        
        // 1. Verificar si el pedido existe y cuál es su estado
        const checkReq = pool.request();
        checkReq.input('pedido', sql.Int, pedidoId);
        const checkRes = await checkReq.query('SELECT [ESTADO] FROM pedidos WHERE [pedido] = @pedido');
        
        if (checkRes.recordset.length === 0) {
            // El pedido ya no existe en MS SQL, permitimos continuar para limpiar SQLite
            return { deleted: true, reason: 'not_found' };
        }
        
        const estado = checkRes.recordset[0].ESTADO ? checkRes.recordset[0].ESTADO.trim() : '';
        if (estado !== 'PE') {
            return { deleted: false, reason: 'not_pending', estado: estado };
        }
        
        // 2. Si el estado es 'PE', procedemos con el borrado transaccional
        transaction = new sql.Transaction(pool);
        await transaction.begin();
        
        const requestPartidas = new sql.Request(transaction);
        requestPartidas.input('pedido', sql.Int, pedidoId);
        await requestPartidas.query('DELETE FROM pedpar WHERE [pedido] = @pedido');
        
        const requestPedido = new sql.Request(transaction);
        requestPedido.input('pedido', sql.Int, pedidoId);
        await requestPedido.query('DELETE FROM pedidos WHERE [pedido] = @pedido');
        
        await transaction.commit();
        console.log(`✅ Pedido MS SQL #${pedidoId} y sus partidas eliminados correctamente.`);
        return { deleted: true, reason: 'deleted' };
    } catch (err) {
        if (transaction) {
            try {
                await transaction.rollback();
            } catch (rollbackErr) {
                console.error('Error al hacer rollback del pedido:', rollbackErr);
            }
        }
        console.error(`Error al eliminar el pedido ${pedidoId} en MS SQL:`, err);
        throw err;
    }
}

module.exports = {
    sql,
    connectToDatabase,
    query,
    searchProducts,
    createSqlClient,
    createSqlPedido,
    deleteSqlPedido
};

