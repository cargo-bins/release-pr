const { getInput } = require("@actions/core");
const { object, string, bool } = require("yup");

const SCHEMA = object({
	version: string()
		.lowercase()
		.matches(
			/^(?:release|patch|minor|major|alpha|beta|rc|\d+[.]\d+[.]\d+(?:-\w+(?:[.]\d+)?)?(?:+\w+)?)$/
		)
		.required(),
	crate: object({
		name: string().optional(),
		path: string().optional(),
	})
		.noUnknown()
		.required(),
	git: object({
		name: string().required(),
		email: string().required().email(),
		branchPrefix: string().required(),
		branchSeparator: string().default("/"),
	})
		.noUnknown()
		.required(),
	pr: object({
		title: string().required(),
		label: string().optional(),
		draft: bool().default(false),
		modifiable: bool().default(true),

		template: string().optional(),
		templateFile: string().optional(),
		templateExclusive: bool().when(["template", "templateFile"], {
			is: (string, file) =>
				(string?.length ?? 0) > 0 && (file?.length ?? 0) > 0,
			then: bool().required(
				"template and templateFile are mutually exclusive"
			),
			else: bool(),
		}),

		mergeStrategy: string()
			.oneOf(["squash", "merge", "rebase", "bors"])
			.default("squash"),
		releaseNotes: bool().default(false),
	})
		.noUnknown()
		.required(),
}).noUnknown();

async function getInputs() {
	const inputs = await SCHEMA.validate({
		version: getInput("version"),
		crate: {
			name: getInput("crate-name"),
			path: getInput("crate-path"),
		},
		git: {
			name: getInput("git-user-name"),
			email: getInput("git-user-email"),
			branchPrefix: getInput("branch-prefix"),
		},
		pr: {
			title: getInput("pr-title"),
			label: getInput("pr-label"),
			draft: getInput("pr-draft"),
			modifiable: getInput("pr-modifiable"),

			template: getInput("pr-template"),
			templateFile: getInput("pr-template-file"),

			mergeStrategy: getInput("pr-merge-strategy"),
			releaseNotes: getInput("pr-release-notes"),
		},
	});

	delete inputs.templateExclusive;
	return inputs;
}

exports.SCHEMA = SCHEMA;
exports.getInputs = getInputs;
