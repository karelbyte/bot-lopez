const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');

async function generateQuotePdf(user, items, pedidoId = null) {
    return new Promise((resolve, reject) => {
        try {
            const dir = path.join(__dirname, 'quotes_pdfs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);

            const fileName = `Cotizacion_${user.phone}_${Date.now()}.pdf`;
            const filePath = path.join(dir, fileName);

            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const writeStream = fs.createWriteStream(filePath);
            doc.pipe(writeStream);

            const brandColor = '#9F1C87';

            // Logo o Texto Alternativo
            const logoPng = path.join(__dirname, 'logo.png');
            const logoJpg = path.join(__dirname, 'logo.jpg');
            
            if (fs.existsSync(logoPng)) {
                doc.image(logoPng, 50, 45, { width: 150 });
            } else if (fs.existsSync(logoJpg)) {
                doc.image(logoJpg, 50, 45, { width: 150 });
            } else {
                doc.font('Helvetica-Bold').fillColor(brandColor).fontSize(24).text('Lopez Impresores', 50, 50);
            }

            // Datos de Contacto de la Empresa (Alineados a la derecha)
            doc.font('Helvetica').fillColor('#444444').fontSize(10)
               .text('https://lopezimpresores.mx/', 0, 50, { align: 'right' })
               .text('(755) 554-2478 / 554-2578', 0, 65, { align: 'right' })
               .text('ventas@lopezimpresores.mx', 0, 80, { align: 'right' });

            // Línea divisoria
            doc.moveTo(50, 110).lineTo(545, 110).strokeColor(brandColor).lineWidth(2).stroke();

            // Título de la Cotización
            doc.font('Helvetica-Bold').fillColor(brandColor).fontSize(20).text('COTIZACIÓN', 50, 150);
            if (pedidoId) {
                doc.fontSize(14).text(`Folio: ${pedidoId}`, 0, 155, { align: 'right' });
            }
            
            // Datos del Cliente y Fecha (Movidos acordemente)
            doc.font('Helvetica').fillColor('#000').fontSize(11).text(`Fecha: ${new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}`, 50, 180);
            doc.text(`Cliente: ${user.name}`, 50, 195);

            doc.moveDown(2);

            let totalGeneral = 0;
            let totalSubtotal = 0;
            let totalIva = 0;

            const tableRows = items.map(item => {
                const subtotalItem = item.total_unitario * item.cantidad;

                totalSubtotal += item.precio_unitario * item.cantidad;
                totalIva += item.monto_iva * item.cantidad;
                totalGeneral += subtotalItem;

                return [
                    item.articulo || '',
                    item.cantidad.toString(),
                    item.descrip,
                    `$${item.precio_unitario.toFixed(2)}`,
                    `$${item.monto_iva.toFixed(2)}`,
                    `$${item.total_unitario.toFixed(2)}`,
                    `$${subtotalItem.toFixed(2)}`
                ];
            });
            
            // Configuración de la Tabla (Ancho total ~495)
            const table = {
                title: "Detalle de Artículos",
                headers: [
                    { label: "Artículo", width: 60 },
                    { label: "Cant.", width: 35, align: "center" },
                    { label: "Descripción", width: 140 },
                    { label: "P. Base", width: 65, align: "right" },
                    { label: "I.V.A.", width: 60, align: "right" },
                    { label: "P. Total", width: 65, align: "right" },
                    { label: "Subtotal", width: 70, align: "right" }
                ],
                rows: tableRows
            };

            doc.table(table, {
                prepareHeader: () => doc.font("Helvetica-Bold").fontSize(9).fillColor('#000000'),
                prepareRow: (row, index, column, rect, font) => {
                    doc.font("Helvetica").fontSize(9).fillColor('#000000');
                    return doc;
                },
                columnSpacing: 5,
                padding: 5
            });

            // Gran Total desglosado
            doc.moveDown(1);
            doc.font("Helvetica").fillColor('#444444').fontSize(11).text(`Subtotal: $${totalSubtotal.toFixed(2)}`, { align: 'right' });
            doc.font("Helvetica").fillColor('#444444').fontSize(11).text(`I.V.A. Total: $${totalIva.toFixed(2)}`, { align: 'right' });
            doc.moveDown(0.2);
            doc.font("Helvetica-Bold").fillColor(brandColor).fontSize(16).text(`TOTAL NETO: $${totalGeneral.toFixed(2)}`, { align: 'right' });

            // Línea divisoria inferior
            doc.moveTo(50, doc.y + 20).lineTo(545, doc.y + 20).strokeColor('#e5e7eb').lineWidth(1).stroke();

            // Leyenda Legal
            doc.moveDown(3);
            doc.font("Helvetica-Oblique").fontSize(9).fillColor('#666666')
               .text('Precios sujetos a cambios sin previo aviso. Vigencia de 15 días.', { align: 'center' });

            doc.end();

            writeStream.on('finish', () => resolve(filePath));
            writeStream.on('error', reject);

        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { generateQuotePdf };
