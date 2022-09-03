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

	const baseBranch = inputs.baseBranch || (await getDefaultBranch());
	const branchName = await makeBranch(inputs.version, inputs.git);

	const crate = await findCrate(inputs.crate);
	const newVersion = await runCargoRelease(crate, inputs.version, branchName);

	await pushBranch(branchName);
	await makePR(inputs, crate, baseBranch, branchName, newVersion);
} catch (error) {
	core.setFailed(error.message);
}

async function setGithubUser({ name, email }) {
	core.info(`Setting git user details: ${name} <${email}>`);

	await execAndSucceed("git", ["config", "user.name", name]);
	await execAndSucceed("git", ["config", "user.email", email]);
}

async function getDefaultBranch() {
	core.debug("asking github API for repo's default branch");
	const octokit = github.getOctokit();
	const {
		data: { default_branch },
	} = await octokit.request("GET /repos/{owner}/{repo}", repoSplit());
	return default_branch;
}

async function makeBranch(version, { branchPrefix, branchSeparator }) {
	const branchName = [branchPrefix, version].join(branchSeparator);
	core.info(`Creating branch ${branchName}`);

	await execAndSucceed("git", ["switch", "-c", branchName]);
	core.setOutput("pr-branch", branchName);
	return branchName;
}

async function findCrate({ name, path }) {
	// figure out which crate we're looking at and ensure both of these are set:
	return { name, path };
}

async function runCargoRelease(crate, version, branchName) {
	core.debug("checking for presence of cargo-release");
	if (!(await toolExists("cargo-release"))) {
		core.warning(
			"cargo-release is not available, attempting to install it"
		);

		if (await toolExists("cargo-binstall")) {
			core.info("trying to install cargo-release with cargo-binstall");
			await execAndSucceed("cargo", ["binstall", "cargo-release"]);
		} else {
			core.info("trying to install cargo-release with cargo-install");
			await execAndSucceed("cargo", ["install", "cargo-release"]);
		}
	}

	await execAndSucceed(
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
	await execAndSucceed("git", ["push", "origin", branchName]);
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

	core.debug(`template variables: ${JSON.stringify(vars)}`);

	core.debug("rendering PR title template");
	const title = render(pr.title, vars);
	core.debug(`title rendered to "${title}"`);

	vars.title = title;

	let template = pr.template;
	if (pr.templateFile) {
		core.debug(`reading template from file: ${pr.templateFile}`);
		template = await fs.readFile(pr.templateFile);
	} else {
		core.debug("using template from input");
	}

	if (template.trim().length === 0) {
		core.debug("using default template");
		template = await fs.readFile(
			path.join(__dirname, "default-template.ejs")
		);
	}

	core.debug("rendering PR body template");
	const body = render(template, vars);

	core.debug("making request to github to create PR");
	const octokit = github.getOctokit();
	const {
		data: { url },
	} = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
		...repoSplit(),
		title,
		body,
		head: branchName,
		base: baseBranch,
		maintainer_can_modify: pr.modifiable,
		draft: pr.draft,
	});

	core.info(`PR opened: ${url}`);
	core.setOutput("pr-url", url);
}

function render(template, vars) {
	return ejs.render(template, vars);
}

function repoSplit() {
	const [owner, repo] = github.context.github.repo.split("/", 2);
	return { owner, repo };
}

async function execAndSucceed(program, args) {
	core.debug(`running ${program} with arguments: ${JSON.stringify(args)}`);
	const exit = await exec.exec(program, args);
	if (exit !== 0) throw new Error(`${program} exited with code ${exit}`);
}

async function toolExists(name) {
	try {
		core.debug(`running "${name} --version"`);
		const code = await exec.exec(name, "--version");
		core.debug(`program exited with code ${code}`);
		return code === 0;
	} catch (err) {
		core.debug(`program errored: ${err}`)
		return false;
	}
}
