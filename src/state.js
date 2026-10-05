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
		sections: {},
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
			sections:
				state.sections && typeof state.sections === 'object'
					? state.sections
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
		sections: state.sections ?? {},
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
		const existing = state.assignments[assignment.id];
		state.assignments[assignment.id] = {
			...assignment,
			seenAt: existing ? existing.seenAt : recordedAt,
		};
	}

	return state;
}

export function findNewOrUpdatedSections(sections, state) {
	const results = [];
	const existingSections = state.sections || {};

	for (const section of sections) {
		const existing = existingSections[section.id];
		if (!existing) {
			results.push({
				...section,
				event: 'created',
			});
		} else if (existing.contentHash !== section.contentHash) {
			results.push({
				...section,
				event: 'updated',
			});
		}
	}

	return results;
}

export function recordSections(state, sections) {
	if (!state.sections) {
		state.sections = {};
	}
	const recordedAt = new Date().toISOString();

	for (const section of sections) {
		const existing = state.sections[section.id];
		const isUpdated = existing && existing.contentHash !== section.contentHash;

		state.sections[section.id] = {
			id: section.id,
			type: 'section',
			courseId: section.courseId,
			courseName: section.courseName,
			sectionId: section.sectionId,
			name: section.name,
			url: section.url,
			contentHash: section.contentHash,
			weekStart: section.weekStart,
			weekEnd: section.weekEnd,
			seenAt: existing ? existing.seenAt : recordedAt,
			updatedAt: isUpdated ? recordedAt : existing?.updatedAt || recordedAt,
		};
	}

	return state;
}

