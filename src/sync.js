import {
	findNewAssignments,
	loadState,
	recordAssignments,
	saveState,
} from './state.js';

export async function syncAssignments(assignments, filePath = 'state.json') {
	const state = await loadState(filePath);
	const firstRun = !state.initialized;
	const newAssignments = state.initialized
		? findNewAssignments(assignments, state)
		: [];

	recordAssignments(state, assignments);
	await saveState(state, filePath);

	return {
		firstRun,
		newAssignments,
		state,
	};
}
