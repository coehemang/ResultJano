const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

async function mergePDFs(inputDir, outputPath) {
  const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.pdf'));
  
  if (files.length === 0) {
    console.log('No PDF files found to merge');
    // Create an empty PDF if no files exist
    const emptyPdf = await PDFDocument.create();
    const emptyPage = emptyPdf.addPage([600, 800]);
    emptyPage.drawText('No results found', {
      x: 50,
      y: 700,
      size: 30
    });
    const emptyBytes = await emptyPdf.save();
    fs.writeFileSync(outputPath, emptyBytes);
    return;
  }
  
  const mergedPdf = await PDFDocument.create();

  // Sort files to maintain order
  files.sort();

  for (const file of files) {
    try {
      const filePath = path.join(inputDir, file);
      const pdfBytes = fs.readFileSync(filePath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    } catch (err) {
      console.error(`Error processing PDF file ${file}:`, err.message);
      // Continue with other files even if one fails
    }
  }

  const mergedBytes = await mergedPdf.save();
  fs.writeFileSync(outputPath, mergedBytes);
}

module.exports = { mergePDFs };
