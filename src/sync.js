import {
	DEFAULT_STATE_PATH,
	findNewAssignments,
	loadState,
	recordAssignments,
	saveState,
} from './state.js';

export async function syncAssignments(
	assignments,
	filePath = process.env.ODTUCLASS_STATE_PATH || DEFAULT_STATE_PATH,
) {
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
