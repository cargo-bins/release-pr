const fs = require("fs").promises;
const path = require("path");

const core = require("@actions/core");
const exec = require("@actions/exec");
const github = require("@actions/github");
const ejs = require("ejs");

const { getInputs } = require("./schema");

try {
	const inputs = await getInputs();
	await setGithubUser(inputs.git);

	const baseBranch = inputs.baseBranch || (await getCurrentBranch());
	const branchName = await makeBranch(inputs.version, inputs.git);

	const crate = await findCrate(inputs.crate);
	const newVersion = await runCargoRelease(crate, inputs.version, branchName);

	await pushBranch(branchName);
	await makePR(inputs, crate, baseBranch, branchName, newVersion);
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

async function findCrate({ name, path }) {
	// figure out which crate we're looking at and ensure both of these are set:
	return { name, path };
}

async function runCargoRelease(crate, version, branchName) {
	// get cargo-release somehow if not already available

	await exec.exec(
		"cargo",
		[
			"release",
			"--execute",
			"--no-push",
			"--no-tag",
			"--no-publish",
			"--no-confirm",
			"--verbose",
			// "--config", "release.toml", // keep?
			"--allow-branch",
			branchName,
			"--dependent-version",
			"upgrade",
			version,
		],
		{ cwd: crate.path }
	);

	// figure out version just created
	// core.setOutput('version', newVersion);
	// return newVersion;
}

async function pushBranch(branchName) {
	await exec.exec("git", ["push", "origin", branchName]);
}

async function makePR(inputs, crate, baseBranch, branchName, newVersion) {
	const { pr } = inputs;
	const vars = {
		pr,
		crate,
		version: {
			actual: newVersion,
			desired: inputs.version,
		},
		branchName,
		crateName: crate.name,
		cratePath: crate.path,
	};

	const title = render(pr.title, vars);
	vars.title = title;

	let template = pr.template;
	if (pr.templateFile) {
		template = await fs.readFile(pr.templateFile);
	}
	if (template.trim().length === 0) {
		template = await fs.readFile(
			path.join(__dirname, "default-template.ejs")
		);
	}
	const body = render(template, vars);

	const [owner, repo] = github.context.github.repo.split('/', 2);

	const octokit = github.getOctokit();
	const { data: { url } } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
		owner,
		repo,
		title,
		body,
		head: branchName,
		base: baseBranch,
		maintainer_can_modify: pr.modifiable,
		draft: pr.draft,
	});

	console.info(`PR opened: ${url}`);
	core.setOutput("pr-url", url);
}

function render(template, vars) {
	return ejs.render(template, vars);
}
