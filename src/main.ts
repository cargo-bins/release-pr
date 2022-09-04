import {promises as fs} from 'fs';
import {join} from 'path';

import {
	setFailed,
	info,
	debug,
	setOutput,
	error as _error,
	warning
} from '@actions/core';
import {exec as _exec, ExecOptions, getExecOutput} from '@actions/exec';
import {getOctokit, context} from '@actions/github';
import {render as _render} from 'ejs';

import getInputs, {InputsType} from './schema';
import {Octokit} from '@octokit/core';

(async () => {
	try {
		const inputs = await getInputs();
		await setGithubUser(inputs.git);

		const octokit = getOctokit(inputs.githubToken);

		const baseBranch =
			inputs.baseBranch || (await getDefaultBranch(octokit));
		const branchName = await makeBranch(inputs.version, inputs.git);

		const crate = await findCrate(inputs.crate);
		const newVersion = await runCargoRelease(
			crate,
			inputs.version,
			branchName
		);

		await pushBranch(branchName);
		await makePR(
			octokit,
			inputs,
			crate,
			baseBranch,
			branchName,
			newVersion
		);
	} catch (error: unknown) {
		if (error instanceof Error) setFailed(error.message);
		else if (typeof error === 'string') setFailed(error);
		else setFailed('An unknown error has occurred');
	}
})();

async function setGithubUser({
	name,
	email
}: {
	name: string;
	email: string;
}): Promise<void> {
	info(`Setting git user details: ${name} <${email}>`);

	await execAndSucceed('git', ['config', 'user.name', name]);
	await execAndSucceed('git', ['config', 'user.email', email]);
}

async function getDefaultBranch(octokit: Octokit): Promise<string> {
	debug("asking github API for repo's default branch");
	const {
		data: {default_branch}
	} = await octokit.request('GET /repos/{owner}/{repo}', context.repo);
	return default_branch;
}

async function makeBranch(
	version: string,
	{
		branchPrefix,
		branchSeparator
	}: {branchPrefix: string; branchSeparator: string}
): Promise<string> {
	const branchName = [branchPrefix, version].join(branchSeparator);
	info(`Creating branch ${branchName}`);

	await execAndSucceed('git', ['switch', '-c', branchName]);
	setOutput('pr-branch', branchName);
	return branchName;
}

interface CrateArgs {
	name?: string | undefined | null;
	path?: string | undefined | null;
}

interface CrateDetails {
	name: string;
	path: string;
	version: string;
}

async function findCrate({name, path}: CrateArgs): Promise<CrateDetails> {
	if (!name && !path) {
		// check for a valid crate at the root
		try {
			return await pkgid();
		} catch (err) {
			_error(
				'No crate found at the root, try specifying crate-name or crate-path.'
			);
			throw err;
		}
	} else if (name && !path) {
		return pkgid({name});
	} else if (!name && path) {
		return pkgid({path});
	} else {
		// check that we can get a valid crate given all the inputs
		try {
			return await pkgid({name, path});
		} catch (err) {
			_error(
				'crate-name and crate-path conflict; prefer only specifying one or fix the mismatch.'
			);
			throw err;
		}
	}
}

async function runCargoRelease(
	crate: CrateDetails,
	version: string,
	branchName: string
): Promise<string> {
	debug('checking for presence of cargo-release');
	if (!(await toolExists('cargo-release'))) {
		warning('cargo-release is not available, attempting to install it');

		if (await toolExists('cargo-binstall')) {
			info('trying to install cargo-release with cargo-binstall');
			await execAndSucceed('cargo', ['binstall', 'cargo-release']);
		} else {
			info('trying to install cargo-release with cargo-install');
			await execAndSucceed('cargo', ['install', 'cargo-release']);
		}
	}

	debug('running cargo release');
	await execAndSucceed(
		'cargo',
		[
			'release',
			'--execute',
			'--no-push',
			'--no-tag',
			'--no-publish',
			'--no-confirm',
			'--verbose',
			// "--config", "release.toml", // keep?
			'--allow-branch',
			branchName,
			'--dependent-version',
			'upgrade',
			version
		],
		{cwd: crate.path}
	);

	debug('checking version after releasing');
	const {version: newVersion} = await pkgid(crate);
	info(`new version: ${newVersion}`);

	if (newVersion === crate.version)
		throw new Error('New and old versions are identical, not proceeding');

	setOutput('version', newVersion);
	return newVersion;
}

async function pushBranch(branchName: string): Promise<void> {
	await execAndSucceed('git', ['push', 'origin', branchName]);
}

async function makePR(
	octokit: Octokit,
	inputs: InputsType,
	crate: CrateDetails,
	baseBranch: string,
	branchName: string,
	newVersion: string
): Promise<void> {
	const {pr} = inputs;
	const vars: TemplateVars = {
		pr,
		crate: {
			name: crate.name,
			path: crate.path
		},
		version: {
			previous: crate.version,
			actual: newVersion,
			desired: inputs.version
		},
		branchName
	};

	debug(`template variables: ${JSON.stringify(vars)}`);

	debug('rendering PR title template');
	const title = render(pr.title, vars);
	debug(`title rendered to "${title}"`);

	vars.title = title;

	let template = pr.template;
	if (pr.templateFile) {
		debug(`reading template from file: ${pr.templateFile}`);
		template = await fs.readFile(pr.templateFile, 'utf-8');
	} else {
		debug('using template from input');
	}

	if (!template?.trim().length) {
		debug('using default template');
		template = await fs.readFile(
			join(__dirname, 'default-template.ejs'),
			'utf-8'
		);
	}

	debug('rendering PR body template');
	const body = render(template, vars);

	debug('making request to github to create PR');
	const {
		data: {url}
	} = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
		...context.repo,
		title,
		body,
		head: branchName,
		base: baseBranch,
		maintainer_can_modify: pr.modifiable,
		draft: pr.draft
	});

	info(`PR opened: ${url}`);
	setOutput('pr-url', url);
}

interface TemplateVars {
	pr: {
		title: string;
		label?: string;
		draft: boolean;
		modifiable: boolean;

		template?: string;
		templateFile?: string;

		mergeStrategy: string;
		releaseNotes: boolean;
	};
	crate: {
		name: string;
		path: string;
	};
	version: {
		previous: string;
		actual: string;
		desired: string;
	};
	branchName: string;
	title?: string;
}

function render(template: string, vars: TemplateVars): string {
	return _render(template, vars);
}

async function execAndSucceed(
	program: string,
	args: string[],
	options: ExecOptions = {}
): Promise<void> {
	debug(`running ${program} with arguments: ${JSON.stringify(args)}`);
	const exit = await _exec(program, args, options);
	if (exit !== 0) throw new Error(`${program} exited with code ${exit}`);
}

async function toolExists(name: string): Promise<boolean> {
	try {
		debug(`running "${name} --help"`);
		const code = await _exec(name, ['--help']);
		debug(`program exited with code ${code}`);
		return code === 0;
	} catch (err) {
		debug(`program errored: ${err}`);
		return false;
	}
}

async function execWithOutput(
	program: string,
	args: string[]
): Promise<string> {
	debug(`running ${program} with arguments: ${JSON.stringify(args)}`);
	const {exitCode, stdout} = await getExecOutput(program, args);
	if (exitCode !== 0)
		throw new Error(`${program} exited with code ${exitCode}`);
	return stdout;
}

async function pkgid({name, path}: CrateArgs = {}): Promise<CrateDetails> {
	debug(`checking and parsing pkgid for name=${name} path=${path}`);

	const args = ['pkgid'];
	if (name) args.push('--package', name);
	if (path) args.push('--manifest-path', join(path, 'Cargo.toml'));

	const id = await execWithOutput('cargo', args);
	debug(`got pkgid: ${id}`);

	const {protocol, pathname, hash} = new URL(id);
	if (protocol !== 'file:')
		throw new Error('pkgid is returning a non-local crate');

	const [crateName, version] = hash.split('#', 2)[1]?.split('@', 2) ?? [];
	if (!crateName) throw new Error(`failed to parse crate name from ${hash}`);

	debug(`got pathname: ${pathname}`);
	debug(`got crate name: ${crateName}`);
	debug(`got crate version: ${version}`);

	return {name: crateName, path: pathname, version};
}
