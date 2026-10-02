import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATE_VERSION = 1;
export const DEFAULT_STATE_PATH = '.odtuclass/state.json';

function getStatePath(filePath) {
	return filePath || process.env.ODTUCLASS_STATE_PATH || DEFAULT_STATE_PATH;
}

export function createEmptyState() {
	return {
		version: STATE_VERSION,
		initialized: false,
		assignments: {},
	};
}

export async function loadState(filePath) {
	const statePath = getStatePath(filePath);

	try {
		const contents = await readFile(statePath, 'utf8');
		const state = JSON.parse(contents);

		if (!state || typeof state !== 'object') {
			throw new Error('State file must contain a JSON object.');
		}

		return {
			version: state.version ?? STATE_VERSION,
			initialized: state.initialized === true,
			assignments:
				state.assignments && typeof state.assignments === 'object'
					? state.assignments
					: {},
		};
	} catch (error) {
		if (error.code === 'ENOENT') {
			return createEmptyState();
		}

		throw new Error(`Could not load state: ${error.message}`);
	}
}

export async function saveState(state, filePath) {
	const statePath = getStatePath(filePath);
	const normalizedState = {
		version: STATE_VERSION,
		initialized: true,
		assignments: state.assignments ?? {},
	};

	 await mkdir(dirname(statePath), { recursive: true });
	 await writeFile(
		 statePath,
		`${JSON.stringify(normalizedState, null, 2)}\n`,
		'utf8',
	);
}

export function findNewAssignments(assignments, state) {
	return assignments.filter(
		(assignment) => !Object.hasOwn(state.assignments, assignment.id),
	);
}

export function recordAssignments(state, assignments) {
	const recordedAt = new Date().toISOString();

	for (const assignment of assignments) {
		state.assignments[assignment.id] = {
			...assignment,
			seenAt: recordedAt,
		};
	}

	return state;
}
