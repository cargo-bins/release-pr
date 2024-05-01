import {promises as fs} from 'fs';
import {join, normalize, resolve} from 'path';

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
import semver from 'semver';

import getInputs, {InputsType} from './schema';
import {Octokit} from '@octokit/core';

(async () => {
	try {
		const inputs = await getInputs();

		const crates = await findCrates(inputs.crate);

		await setGithubUser(inputs.git);
		await unshallowGit();
		await fetchGitTags();

		const octokit = getOctokit(inputs.githubToken);

		const baseBranch =
			inputs.baseBranch || (await getDefaultBranch(octokit));
		const branchCore =
			(crates.length === 1 ? crates[0]?.name : 'all') ?? 'crate';
		let branchName = makeBranchName(inputs.version, branchCore, inputs.git);
		await makeBranch(branchName);

		const newVersion = await runCargoRelease(
			crates,
			inputs.version,
			branchName
		);

		if (inputs.checkSemver) {
			for (const crate of crates) {
				await runSemverChecks(crate);
			}
		}

		if (inputs.checkPackage) {
			for (const crate of crates) {
				await execAndSucceed('cargo', [
					'publish',
					'--dry-run',
					'-p',
					crate.name
				]);
			}
		}

		if (inputs.version !== newVersion) {
			branchName = makeBranchName(newVersion, branchCore, inputs.git);
			await renameBranch(branchName);
		}

		setOutput('pr-branch', branchName);
		await pushBranch(branchName);
		await makePR(
			octokit,
			inputs,
			crates,
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

async function unshallowGit(): Promise<void> {
	info('Fetching all history so cargo-release can read it');
	await execAndSucceed('git', ['fetch', '--unshallow']);
}

async function fetchGitTags(): Promise<void> {
	info('Pulling git tags so cargo-release can read them');
	await execAndSucceed('git', ['fetch', '--tags']);
}

async function getDefaultBranch(octokit: Octokit): Promise<string> {
	debug("asking github API for repo's default branch");
	const {
		data: {default_branch}
	} = await octokit.request('GET /repos/{owner}/{repo}', context.repo);
	return default_branch;
}

type BranchOpts = {branchPrefix: string; branchSeparator: string};
function makeBranchName(
	version: string,
	crate: false | string,
	{branchPrefix, branchSeparator}: BranchOpts
): string {
	return [branchPrefix, crate, version].filter(_ => _).join(branchSeparator);
}

async function makeBranch(branchName: string): Promise<void> {
	info(`Creating branch ${branchName}`);
	await execAndSucceed('git', ['switch', '-c', branchName]);
}

async function renameBranch(branchName: string): Promise<void> {
	info(`Renaming branch to ${branchName}`);
	await execAndSucceed('git', ['branch', '-M', branchName]);
}

interface CrateArgs {
	name?: string | undefined | null;
	path?: string | undefined | null;
	releaseAll?: boolean;
}

interface CrateDetails {
	name: string;
	path: string;
	version: string;
}

async function findCrates({
	name,
	path,
	releaseAll
}: CrateArgs): Promise<CrateDetails[]> {
	if (!name && !path) {
		// check for a valid crate at the root
		try {
			return await pkgid({releaseAll});
		} catch (err) {
			_error(
				'No crates found at the root, try specifying crate-name, crate-path, or crate-release-all.'
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

async function installToolIfNotExists(tool: string): Promise<void> {
	debug(`checking for presence of ${tool}`);
	if (!(await toolExists(tool))) {
		warning(`${tool} is not available, attempting to install it`);

		if (await toolExists('cargo-binstall')) {
			info(`trying to install ${tool} with cargo-binstall`);
			await execAndSucceed('cargo', ['binstall', '--no-confirm', tool]);
		} else {
			info(`trying to install ${tool} with cargo-install`);
			await execAndSucceed('cargo', ['install', tool]);
		}
	}
}

async function runCargoRelease(
	crates: CrateDetails[],
	version: string,
	branchName: string
): Promise<string> {
	await installToolIfNotExists('cargo-release');

	debug('running cargo release');
	const workspaceRoot: string = JSON.parse(
		await execWithOutput('cargo', ['metadata', '--format-version=1'])
	)?.workspace_root;
	debug(`got workspace root: ${workspaceRoot}`);

	const cwd = (crates.length === 1 ? crates[0]?.path : null) ?? workspaceRoot;
	debug(`got cwd: ${cwd}`);

	const crVersion = semver.clean(
		((await execWithOutput('cargo', ['release', '--version'])).match(
			/cargo-release\s+([\d.]+)/i
		) ?? [])[1] ?? ''
	);
	debug(`got cargo-release version: ${crVersion}`);
	if (crVersion && semver.satisfies(crVersion, '>=0.23.0')) {
		debug('Using new cargo-release');

		try {
			info('Changes since last release (if any):');
			await execAndSucceed('cargo', ['release', 'changes'], {cwd});
		} catch (_err: unknown) {
			// ignore
		}

		info('Bump version');
		await execAndSucceed(
			'cargo',
			[
				'release',
				'version',
				version,
				'--execute',
				'--verbose',
				'--no-confirm',
				'--allow-branch',
				branchName
			],
			{cwd}
		);

		info('Update lockfile and run check');
		await execAndSucceed('cargo', ['check'], {cwd});

		info('Perform replaces');
		await execAndSucceed(
			'cargo',
			['release', 'replace', '--execute', '--verbose', '--no-confirm'],
			{cwd}
		);

		info('Run hooks');
		await execAndSucceed(
			'cargo',
			['release', 'hook', '--execute', '--verbose', '--no-confirm'],
			{cwd}
		);

		info('Commit');
		await execAndSucceed(
			'cargo',
			['release', 'commit', '--execute', '--verbose', '--no-confirm'],
			{cwd}
		);
	} else {
		debug('Using old cargo-release');
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
				'--allow-branch',
				branchName,
				version
			],
			{cwd}
		);
	}

	debug('checking version after releasing');

	const newCrates =
		crates.length === 1
			? await pkgid({name: crates[0].name, path: crates[0].path})
			: await pkgid({releaseAll: true});

	// at this point, we should have a single version even if there are multiple crates
	const newVersion = newCrates[0].version;

	info(`new version: ${newVersion}`);

	if (newVersion === crates[0].version)
		throw new Error('New and old versions are identical, not proceeding');

	setOutput('version', newVersion);
	return newVersion;
}

async function runSemverChecks(crate: CrateDetails): Promise<void> {
	debug('checking for presence of cargo-semver-checks');
	if (!(await toolExists('cargo-semver-checks'))) {
		warning(
			'cargo-semver-checks is not available, attempting to install it'
		);

		if (await toolExists('cargo-binstall')) {
			info('trying to install cargo-semver-checks with cargo-binstall');
			await execAndSucceed('cargo', [
				'binstall',
				'--no-confirm',
				'cargo-semver-checks'
			]);
		} else {
			info('trying to install cargo-semver-checks with cargo-install');
			await execAndSucceed('cargo', ['install', 'cargo-semver-checks']);
		}
	}

	debug('running cargo semver-checks');
	await execAndSucceed(
		'cargo',
		[
			'semver-checks',
			'check-release',
			'--package',
			crate.name,
			'--verbose'
		],
		{cwd: crate.path}
	);
}

async function pushBranch(branchName: string): Promise<void> {
	await execAndSucceed('git', ['push', 'origin', branchName]);
}

async function makePR(
	octokit: Octokit,
	inputs: InputsType,
	crateDetails: CrateDetails[],
	baseBranch: string,
	branchName: string,
	newVersion: string
): Promise<void> {
	const {pr} = inputs;
	const crates = crateDetails.map(({name, path}) => ({name, path}));
	const vars: TemplateVars = {
		pr,
		crate: crates[0],
		crates,
		version: {
			previous: crateDetails[0].version,
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

	debug(`API URL for PR: ${url}`);

	// from: https://api.github.com/repos/passcod/cargo-release-pr-test/pulls/1
	// to:   https://github.com/passcod/cargo-release-pr-test/pulls/1

	const publicUrl = new URL(url);
	publicUrl.hostname = publicUrl.hostname.replace(/^api[.]/, '');
	publicUrl.pathname = publicUrl.pathname
		.replace(/^[/]repos[/]/, '/')
		.replace(/[/]pulls[/](\d+)$/, '/pull/$1');

	info(`PR opened: ${publicUrl}`);
	setOutput('pr-url', publicUrl.toString());
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
		metaComment: boolean;
	};
	crate: {
		name: string;
		path: string;
	};
	crates: {
		name: string;
		path: string;
	}[];
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

function realpath(path: string): string {
	const workdir = process.cwd();
	return resolve(workdir, normalize(path));
}

interface WorkspaceMember {
	name: string;
	version: string;
	location: string;
	private: boolean;
}

async function pkgid(crate: CrateArgs): Promise<CrateDetails[]> {
	await installToolIfNotExists('cargo-workspaces');

	const pkgs: CrateDetails[] = (
		JSON.parse(
			await execWithOutput('cargo', ['workspaces', 'list', '--json'])
		) as WorkspaceMember[]
	).map(({name, version, location}) => ({name, version, path: location}));
	debug(`got workspace members: ${JSON.stringify(pkgs)}`);

	// only bother looping if we're searching for something
	if (crate.name || crate.path) {
		debug(
			`checking and parsing metadata to find name=${crate.name} path=${crate.path}`
		);

		const cratePath = crate.path && realpath(crate.path);
		debug(`realpath of crate.path: ${cratePath}`);

		for (const pkg of pkgs) {
			if (
				(crate.name && crate.name === pkg.name) ||
				(cratePath && cratePath === pkg.path)
			)
				return [pkg];
		}
	} else if (pkgs.length === 1) {
		info('only one crate in workspace, assuming that is it');
		return pkgs;
	} else {
		if (!crate.releaseAll) {
			throw new Error(
				'multiple crates in the workspace, but crate-release-all is false'
			);
		}

		info('multiple crates in the workspace, releasing all');

		const parsed: CrateDetails[] = [];
		let previousVersion = null;

		for (const pkg of pkgs) {
			// ensure that all packages in the workspace have the same version
			if (!previousVersion) {
				previousVersion = pkg.version;
			} else {
				if (pkg.version !== previousVersion) {
					throw new Error(
						`multiple crates with different versions: crate=${pkg.name} version=${pkg.version} expected=${previousVersion}`
					);
				}
			}

			parsed.push(pkg);
		}

		if (!parsed.length) throw new Error('no good crates found');
		return parsed;
	}

	throw new Error('no matching crate found');
}
