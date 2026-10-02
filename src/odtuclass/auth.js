import * as cheerio from 'cheerio';

export async function login(client, username, password) {
	console.log('Connecting to ODTUClass...');

	const loginPage = await client.request(
		'GET',
		`${client.baseUrl}/login/index.php`,
	);

	const $ = cheerio.load(loginPage.data);
	const loginToken = $('input[name="logintoken"]').val();

	if (!loginToken) {
		throw new Error('Could not find logintoken on ODTUClass login page.');
	}

	console.log('Authenticating...');

	const params = new URLSearchParams();

	params.append('username', username);
	params.append('password', password);
	params.append('logintoken', loginToken);

	const loginResponse = await client.request(
		'POST',
		`${client.baseUrl}/login/index.php`,
		params,
	);

	const finalUrl = loginResponse.finalUrl || '';

	if (
		finalUrl.includes('/login/index.php') &&
		!finalUrl.includes('testsession')
	) {
		const $error = cheerio.load(loginResponse.data);
		const errorMessage = $error('#loginerrormessage').text().trim();

		throw new Error(errorMessage || 'ODTUClass login failed.');
	}

	console.log('Loading session information...');

	const dashboard = await client.request(
		'GET',
		`${client.baseUrl}/my/`,
	);

	extractSessionInfo(client, dashboard.data);

	client.username = username;

	console.log(`Authentication successful. User ID: ${client.userId}`);
}

function extractSessionInfo(client, html) {
	const match = html.match(/M\.cfg\s*=\s*(\{.*?\});/s);

	if (!match) {
		throw new Error(
			'Could not extract Moodle session configuration.',
		);
	}

	let config;

	try {
		config = JSON.parse(match[1]);
	} catch {
		throw new Error(
			'Could not parse Moodle session configuration.',
		);
	}

	client.sesskey = config.sesskey;
	client.userId = config.userId;

	if (!client.sesskey) {
		throw new Error('Moodle sesskey was not found.');
	}
}
