const fs = require('fs').promises;
const path = require('path');

const core = require("@actions/core");
const exec = require("@actions/exec");
const github = require("@actions/github");
const ejs = require("ejs");
const yup = require('yup');

const SCHEMA = yup.object({
	version: yup.string().lowercase().matches(/^(?:release|patch|minor|major|alpha|beta|rc|\d+[.]\d+[.]\d+(?:-\w+(?:[.]\d+)?)?(?:+\w+)?)$/).required(),
	crate: yup.object({
		name: yup.string().optional(), // TODO: required if more than one
		path: yup.string().optional(),
	}).noUnknown().required(),
	git: yup.object({
		name: yup.string().required(),
		email: yup.string().required().email(),
		branchPrefix: yup.string().required(),
		branchSeparator: yup.string().default('/'),
	}).noUnknown().required(),
	// TODO: PR/title template options
}).noUnknown();

try {
	const inputs = await SCHEMA.validate({
		version: core.getInput('version'),
		crate: {
			name: core.getInput('crate-name'),
			path: core.getInput('crate-path'),
		},
		git: {
			name: core.getInput('git-user-name'),
			email: core.getInput('git-user-email'),
			branchPrefix: core.getInput('branch-prefix'),
		},
	});

	await setGithubUser(inputs.git);

	const baseBranch = inputs.baseBranch || await getCurrentBranch();
	const branchName = await makeBranch(inputs.version, inputs.git);

	const newVersion = await runCargoRelease(inputs.crate, inputs.version, branchName);

	await pushBranch(branchName);
	await makePR(inputs, baseBranch, branchName, newVersion);

	// const payload = github.context.payload;
} catch (error) {
	core.setFailed(error.message);
}

async function setGithubUser({ name, email }) {
	console.info(`Setting git user details: ${name} <${email}>`);

	await exec.exec("git", ["config", "user.name", name]);
	await exec.exec("git", ["config", "user.email", email]);
}

async function getCurrentBranch() {
	// TODO
}

async function makeBranch(version, { branchPrefix, branchSeparator }) {
	const branchName = [branchPrefix, version].join(branchSeparator);
	console.info(`Creating branch ${branchName}`);

	await exec.exec("git", ["switch", "-c", branchName]);
	core.setOutput("pr-branch", branchName);
	return branchName;
}

async function runCargoRelease(crate, version, branchName) {
	// figure out which crate we're looking at and set cwd
	const cwd = '.';

	// get cargo-release somehow if not already available

	await exec.exec("cargo", ["release",
		"--execute",
		"--no-push",
		"--no-tag",
		"--no-publish",
		"--no-confirm",
		"--verbose",
		// "--config", "release.toml", // keep?
		"--allow-branch", branchName,
		"--dependent-version", "upgrade",
		version,
	], { cwd });

	// figure out version just created
	// core.setOutput('version', newVersion);
	// return newVersion;
}

async function pushBranch(branchName) {
	await exec.exec("git", ["push", "origin", branchName]);
}

async function makePR({ crate, title, label, pr }, baseBranch, branchName, newVersion) {
	const vars = {
		pr,
		crate,
		version: newVersion,
		branchName,
		crateName: crate.name,
		cratePath: crate.path,
	};

	const title = render(title, vars);
	vars.title = title;

	let template = pr.template;
	if (pr.templateFile) {
		template = await fs.readFile(pr.templateFile);
	}
	if (template.trim().length === 0) {
		template = await fs.readFile(path.join(__dirname, 'default-template.ejs'));
	}
	const body = render(template, vars);

	const args = [
		"pr", "create",
		"--title", title,
		"--body", body,
		"--base", baseBranch,
		"--head", branchName,
	];
	if (label) {
		args.push("--label", label);
	}

	// TODO: run with Octokit
	// const octokit = github.getOctokit();

	let toolOutput = '';
	await exec.exec("gh", args, {
		env: {
			GITHUB_TOKEN, // TODO: how to get this?
		},
		listeners: {
			stdout(data) {
				toolOutput += data;
			},
		},
	});

	// parse+normalise URL
	const prUrl = (new URL(toolOutput.trim())).toString();
	console.info(`PR opened: ${prUrl}`);
	core.setOutput('pr-url', prUrl);
}

function render(template, vars) {
	return ejs.render(template, vars);
}
