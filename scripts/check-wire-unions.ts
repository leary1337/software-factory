/** Catch anonymous or renamed copies that the canonical-name guard cannot see. */
interface Vocabulary {
	readonly name: string;
	readonly values: ReadonlySet<string>;
}

const STRING_LITERAL = /["']([\w-]+)["']/g;

/** Delivery constants use string tuples; derive their values instead of copying them. */
export function deliveryVocabularies(source: string): Vocabulary[] {
	const vocabularies: Vocabulary[] = [];
	for (const match of source.matchAll(/export const (\w+)\s*=\s*\[([^\]]+)\]/g)) {
		const name = match[1];
		const values = new Set(
			[...(match[2] ?? "").matchAll(STRING_LITERAL)].map((value) => value[1] ?? ""),
		);
		if (name && values.size >= 3) vocabularies.push({ name, values });
	}
	return vocabularies;
}

/** Token boundaries keep documentation strings from masquerading as type syntax. */
function lexicalSource(source: string): { source: string; literals: Set<number> } {
	const literals = new Set<number>();
	const cleaned = source.replace(
		/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
		(token: string, offset: number) => {
			if (/^["'][\w-]+["']$/.test(token)) literals.add(offset);
			return token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token;
		},
	);
	return { source: cleaned, literals };
}

export function copiedWireUnions(
	text: string,
	vocabularies: readonly Vocabulary[],
): Array<{ line: number; name: string }> {
	const { source, literals } = lexicalSource(text);
	const copies: Array<{ line: number; name: string }> = [];
	const literal = "(?:[\"'][\\w-]+[\"']|null|undefined)";
	const union = new RegExp(`${literal}(?:\\s*\\|\\s*${literal}){2,}`, "g");
	for (const match of source.matchAll(union)) {
		const tokens = [...match[0].matchAll(STRING_LITERAL)];
		if (tokens.some((token) => !literals.has(match.index + token.index))) continue;
		const values = tokens.map((value) => value[1] ?? "");
		// Nullable copies and stale subsets also duplicate wire vocabulary.
		const copy = vocabularies.find(
			(vocabulary) => values.length >= 3 && values.every((value) => vocabulary.values.has(value)),
		);
		if (copy) {
			copies.push({ line: source.slice(0, match.index).split("\n").length, name: copy.name });
		}
	}
	return copies;
}
