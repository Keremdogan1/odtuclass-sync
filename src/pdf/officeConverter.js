import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Inspect buffer and filename to detect Office document type (pptx, ppt, docx, doc)
 */
export function detectOfficeType(buffer, filename = '', contentType = '') {
	const lowerName = (filename || '').toLowerCase();
	const lowerMime = (contentType || '').toLowerCase();

	if (/\.(pptx|ppsx|odp)$/.test(lowerName) || lowerMime.includes('presentationml') || lowerMime.includes('powerpoint')) {
		return 'pptx';
	}
	if (/\.ppt$/.test(lowerName)) {
		return 'ppt';
	}
	if (/\.(docx|odt|rtf)$/.test(lowerName) || lowerMime.includes('wordprocessingml') || lowerMime.includes('msword')) {
		return 'docx';
	}
	if (/\.doc$/.test(lowerName)) {
		return 'doc';
	}

	if (!buffer || buffer.length < 8) return null;

	// Check ZIP magic bytes PK\x03\x04 (used by .pptx and .docx)
	if (
		buffer[0] === 0x50 &&
		buffer[1] === 0x4b &&
		buffer[2] === 0x03 &&
		buffer[3] === 0x04
	) {
		const asciiSample = buffer.slice(0, Math.min(buffer.length, 65536)).toString('latin1');
		if (asciiSample.includes('ppt/') || asciiSample.includes(' slide')) {
			return 'pptx';
		}
		if (asciiSample.includes('word/')) {
			return 'docx';
		}
	}

	// Check OLE2 magic bytes \xD0\xCF\x11\xE0 (used by legacy .ppt and .doc)
	if (
		buffer[0] === 0xd0 &&
		buffer[1] === 0xcf &&
		buffer[2] === 0x11 &&
		buffer[3] === 0xe0
	) {
		const asciiSample = buffer.slice(0, Math.min(buffer.length, 131072)).toString('latin1');
		if (asciiSample.includes('PowerPoint')) {
			return 'ppt';
		}
		if (asciiSample.includes('Word.Document') || asciiSample.includes('Microsoft Word')) {
			return 'doc';
		}
		return 'ppt';
	}

	return null;
}

/**
 * Convert an Office document buffer (.pptx, .ppt, .docx, .doc) to a PDF buffer using LibreOffice (soffice).
 */
export async function convertOfficeBufferToPdf(buffer, originalFilename = 'document.pptx', officeType = null) {
	const detectedType = officeType || detectOfficeType(buffer, originalFilename) || 'pptx';
	const ext = detectedType.startsWith('ppt')
		? detectedType === 'ppt' ? '.ppt' : '.pptx'
		: detectedType === 'doc' ? '.doc' : '.docx';

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'odtuclass-office-'));
	const baseStem = path
		.basename(originalFilename, path.extname(originalFilename))
		.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'document';
	const inputPath = path.join(tmpDir, `${baseStem}${ext}`);
	const outputPdfPath = path.join(tmpDir, `${baseStem}.pdf`);

	try {
		await fs.writeFile(inputPath, buffer);

		const candidates = [
			'soffice',
			'libreoffice',
			'/usr/bin/soffice',
			'/usr/bin/libreoffice',
			'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
		];

		let converted = false;
		let lastErr = null;

		for (const bin of candidates) {
			try {
				await execFileAsync(
					bin,
					[
						'--headless',
						'--nologo',
						'--nofirststartwizard',
						'--convert-to',
						'pdf',
						'--outdir',
						tmpDir,
						inputPath,
					],
					{ timeout: 90000 },
				);
				await fs.access(outputPdfPath);
				converted = true;
				break;
			} catch (err) {
				lastErr = err;
			}
		}

		if (!converted) {
			throw new Error(
				`LibreOffice conversion failed for ${originalFilename}: ${lastErr?.message || 'soffice not found'}`,
			);
		}

		const pdfBuffer = await fs.readFile(outputPdfPath);
		if (pdfBuffer.slice(0, 5).toString('utf8') !== '%PDF-') {
			throw new Error(`Converted file for ${originalFilename} is not a valid PDF.`);
		}

		const pdfFilename = originalFilename.replace(/\.(pptx|ppt|ppsx|odp|docx|doc|odt|rtf)$/i, '') + '.pdf';
		return {
			buffer: pdfBuffer,
			filename: pdfFilename,
			officeType: detectedType,
		};
	} finally {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}
}
