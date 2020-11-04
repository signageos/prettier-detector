#!/usr/bin/env node

import * as prettier from 'prettier';
import * as glob from 'glob';
import * as fs from 'fs';
import * as Debug from 'debug';
import * as commandLineArgs from 'command-line-args';
import * as commandLineUsage from 'command-line-usage';
import 'colors';
import * as diff from 'diff';
const debug = Debug('@signageos/prettier-detector');

const GLOB_OPTIONS = {
	nodir: true,
};

function pick<T extends object, U extends keyof T>(input: T, keys: U[]): Pick<T, U> {
	const output = {} as Pick<T, U>;
	for (const key of Object.keys(input)) {
		if (keys.includes(key as U)) {
			output[key as U] = input[key as U];
		}
	}
	return output;
}

function formatWhiteChars(str: string) {
	return str
	.replace(/ /g, '␣')
	.replace(/\t/g, '→');
}

function printDiff(sourceDiff: diff.Change[]) {
	for (const part of sourceDiff) {
		if (part.added || part.removed) {
			const color = part.added ? 'green' : 'red';
			process.stderr.write(formatWhiteChars(part.value[color]));
		}
	}
}

/** All required adjustable options to detect against */
type AdjustableOptions = Omit<
	prettier.RequiredOptions,
	'filepath' | 'plugins' // Exclude explicitly some options
>;

/**
 * Create type with all possible values which can be set to prettier options.
 * TS detects if you miss something in options detecting.
 */
type IOptionsVariants = {
	[P in keyof AdjustableOptions]: AdjustableOptions[P][];
}

/**
 * Object which is used to detect current code style.
 * It can fail during upgrading of @types/prettier. Then, it should be fixed.
 * However, it not recognize new options values automatically after upgrade.
 */
const DEFAULT_ADJUSTABLE_OPTION_VARIANTS: IOptionsVariants = {
	semi: [true, false],
	singleQuote: [true, false],
	jsxSingleQuote: [true, false],
	trailingComma: ['all', 'es5', 'none'],
	bracketSpacing: [true, false],
	jsxBracketSameLine: [true, false],
	rangeStart: [0, 1], // usually used values (TODO allow parametrize this)
	rangeEnd: [0, 1, Infinity], // usually used values (TODO allow parametrize this)
	parser: [
		'babel',
		'babel-flow',
		'babel-ts',
		'flow',
		'typescript',
		'css',
		'less',
		'scss',
		'json',
		'json5',
		'json-stringify',
		'graphql',
		'markdown',
		'vue',
		'html',
		'angular',
		'mdx',
		'yaml',
		'lwc',
	],
	requirePragma: [true, false],
	insertPragma: [true, false],
	proseWrap: ['always', 'never', 'preserve'],
	arrowParens: ['avoid', 'always'],
	htmlWhitespaceSensitivity: ['css', 'ignore', 'strict'],
	endOfLine: ['auto', 'cr', 'crlf', 'lf'],
	quoteProps: ['as-needed', 'consistent', 'preserve'],
	vueIndentScriptAndStyle: [true, false],
	embeddedLanguageFormatting: ['auto', 'off'],
	printWidth: [80, 140], // usually used values (TODO allow parametrize this)
	tabWidth: [2, 3, 4, 5],
	useTabs: [true, false],
	embeddedInHtml: [true, false],
};

const AVAILABLE_OPTION_KEYS = Object.keys(DEFAULT_ADJUSTABLE_OPTION_VARIANTS) as (keyof IOptionsVariants)[];

const optionDefinitions: (commandLineArgs.OptionDefinition & commandLineUsage.OptionDefinition)[] = [
	{ name: 'verbose', alias: 'v', type: Boolean, description: 'Show debug logs' },
	{ name: 'help', alias: 'h', type: Boolean, description: 'Show this usages help' },
	{ name: 'src', type: String, multiple: true, defaultOption: true, description: 'Source files in glob pattern. E.g.: src/**/*.ts' },
	{
		name: 'detect-option',
		alias: 'k',
		type: String,
		multiple: true,
		description: `Options to be used for detection. Defaults to all options. One or many of\n\n`
			+ `${AVAILABLE_OPTION_KEYS.join('\n')}`,
	},
	{
		name: 'specified-option',
		alias: 'o',
		type: String,
		multiple: true,
		description: `Specify predefined options to be fixed for detection. One or many of\n\n`
			+ `${AVAILABLE_OPTION_KEYS.map((key) => '\t' + key + '=' + DEFAULT_ADJUSTABLE_OPTION_VARIANTS[key as keyof IOptionsVariants]!.join(',')).join('\n')}`,
	},
];

const cliOptions = commandLineArgs(optionDefinitions);

if (cliOptions.help) {
	const sections: commandLineUsage.Section[] = [
		{
			header: 'Prettier detector',
			content: 'Reverse detecting of current code style to create initial .prettierrc config file.',
		},
		{
			header: 'Options',
			optionList: optionDefinitions,
		},
	];
	const usage = commandLineUsage(sections);
	process.stdout.write(usage);
	process.exit(0);
}
const filesPatterns = cliOptions.src;
if (!filesPatterns) {
	console.error(`Missing required argument [--src]`);
	process.exit(1);
}

const detectOptionKeys = cliOptions['detect-option'] ?? AVAILABLE_OPTION_KEYS;
if (detectOptionKeys.some((option: keyof IOptionsVariants) => !AVAILABLE_OPTION_KEYS.includes(option))) {
	console.error(`Incorrect --detect-option`);
	console.error(detectOptionKeys);
	process.exit(1);
}
const specifiedOptionsRaw = cliOptions['specified-option'] ?? [];
const specifiedOptionVariants: IOptionsVariants = specifiedOptionsRaw.reduce((agg: IOptionsVariants, option: string) => ({
	...agg,
	[option.split('=')[0]]: [option.split('=')[1]],
}), {});
if (Object.keys(specifiedOptionVariants).some(
	(key: keyof IOptionsVariants) => !DEFAULT_ADJUSTABLE_OPTION_VARIANTS[key as keyof IOptionsVariants]?.includes(specifiedOptionVariants[key]![0] as never)
)) {
	console.error(`Incorrect --specified-option`);
	console.error(specifiedOptionVariants);
	process.exit(1);
}

const adjustableOptionVariants: IOptionsVariants = {
	...pick(
		DEFAULT_ADJUSTABLE_OPTION_VARIANTS,
		detectOptionKeys,
	),
	...specifiedOptionVariants,
};

function* generatePossibleOptionsOfKey(optionKey: keyof IOptionsVariants, defaultOptions: prettier.Options) {
	for (const optionValue of adjustableOptionVariants[optionKey]!) {
		yield {
			...defaultOptions,
			[optionKey]: optionValue,
		} as prettier.Options;
	}
}

interface ISourceDiffs {
	[filePath: string]: diff.Change[];
}

interface IOptionsRating {
	options: prettier.Options;
	diffCount: number;
	sourceDiffs: ISourceDiffs;
}

function getWinningOptionsRating(optionsRatings: IOptionsRating[]) {
	if (optionsRatings.length === 0) {
		return null;
	}
	let winningOptionsRatting = optionsRatings[0];
	for (const optionsRating of optionsRatings) {
		if (optionsRating.diffCount < winningOptionsRatting.diffCount) {
			winningOptionsRatting = optionsRating;
		}
	}
	return winningOptionsRatting;
}

async function detect(filesPatterns: string[]) {
	debug('detect file patterns', filesPatterns);
	const filePaths = filesPatterns.flatMap((filesPattern) => glob.sync(filesPattern, GLOB_OPTIONS));

	const optionsRatings: IOptionsRating[] = [];

	for (const optionKey of detectOptionKeys) {
		const currentlyWinningOptions = getWinningOptionsRating(optionsRatings)?.options ?? {};
		for (const options of generatePossibleOptionsOfKey(optionKey, currentlyWinningOptions)) {

			try {
				let optionsDiffCount = 0;
				const sourceDiffs: ISourceDiffs = {};
				for (const filePath of filePaths) {
					const originalSource = fs.readFileSync(filePath).toString();
					const formattedSource = prettier.format(originalSource, { ...options, filepath: filePath });
					const sourceDiff = diff.diffChars(originalSource, formattedSource);
					for (const sourceChange of sourceDiff) {
						optionsDiffCount += sourceChange.count ?? 0;
					}
					sourceDiffs[filePath] = sourceDiff;
				}
				const optionsRatting: IOptionsRating = {
					options,
					diffCount: optionsDiffCount,
					sourceDiffs,
				};
				optionsRatings.push(optionsRatting);
			} catch (error) {
				debug('Skipping erred options parsing', error);
			}
		}
	}

	const winningOptionsRatting = getWinningOptionsRating(optionsRatings);

	if (!winningOptionsRatting) {
		console.error(`No options found`);
		process.exit(1);
	}

	for (const filePath in winningOptionsRatting.sourceDiffs) {
		const sourceDiff = winningOptionsRatting.sourceDiffs[filePath];
		process.stderr.write(filePath['blue'] + '\n');
		printDiff(sourceDiff);
	}

	process.stdout.write(JSON.stringify(winningOptionsRatting.options, undefined, 2));
}

detect(filesPatterns);
