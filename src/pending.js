import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_PENDING_DIRECTORY = '.odtuclass/pending';

export async function writePendingAssignment(
	assignment,
	directory = DEFAULT_PENDING_DIRECTORY,
) {
	await mkdir(directory, { recursive: true });

	const filePath = join(directory, `${getPendingFileName(assignment)}.json`);
	await writeFile(filePath, `${JSON.stringify(assignment, null, 2)}\n`, 'utf8');

	return filePath;
}

export async function writePendingSection(
	section,
	directory = DEFAULT_PENDING_DIRECTORY,
) {
	await mkdir(directory, { recursive: true });

	const filePath = join(directory, `${getPendingFileName(section)}.json`);
	await writeFile(filePath, `${JSON.stringify(section, null, 2)}\n`, 'utf8');

	return filePath;
}

export function getPendingFileName(item) {
	if (!item || !item.id) {
		throw new Error('Item must have an id.');
	}

	return item.id.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function getPendingDirectory() {
	return process.env.ODTUCLASS_PENDING_DIR || DEFAULT_PENDING_DIRECTORY;
}
