# Measurement method and reproduction

[Overview](README.md). The scan is local and read-only. It does not install a linting
framework, execute application code, change source files or apply refactorings.
All numbers use `59c8925a7fee4bee9bcb2664bf2cdde781468cd0` and TypeScript **6.0.3**.

## Scope and counting

Input is `git ls-files` at the baseline. Parse tracked `.ts`, `.tsx`, `.js`, `.jsx`,
`.mjs`, `.cjs`, `.mts`, `.cts` files with `createSourceFile(..., Latest, true)`.
There are no parse diagnostics. Untracked builds, dependencies, downloads and runtime
assets are not source. SQL and non-JS/TS files are separately inventoried, not assigned
a TypeScript complexity score.

Classification precedence:
1. Test/support: `*.test.*`, directories `test`, `tests`, `__tests__`, `__fixtures__`,
   `fixtures`, `src/mock`, and `testing.ts/tsx`.
2. Tooling: `src/seed.ts`/`src/seed/`.
3. Runtime: remaining `apps/*/src`, `packages/*/src`, and extension source files.
4. Remaining scripts/build configs/hooks are tooling.

The runtime bucket includes interfaces, schema declarations, translation dictionaries
and import-only entrypoints; it is not a reachability proof or all executable logic.
Test/support includes 540 test files plus helpers/mocks. Physical lines are newline
counts (without an extra line for trailing newline). Nonblank counts retain comments.
Token-bearing lines collect nonempty lines covered by syntax leaves, excluding JSDoc,
ordinary comments, whitespace and EOF. A multi-line string's nonempty content counts;
these values are not interchangeable with statement counts or another tool's SLOC.

## Cyclomatic convention

Each function with a body starts at **1**. Add one for each `if`, ternary expression,
`for`, `for-in`, `for-of`, `while`, `do`, `catch`, non-default `case`, `&&`, `||`, `??`,
`&&=`, `||=` and `??=`. Conditions inside JSX count. Do not add for `else`, `default`,
`return`, optional chaining, an entire switch separately or try/finally. Nested
function bodies are excluded from the outer count and receive their own record.
Methods, constructors, getters/setters, function expressions and arrows are included;
ambient signatures are not.

This is an explicit **McCabe-style AST decision count**, not a control-flow-graph
proof and not asserted to equal ESLint/Sonar or cognitive complexity. The operator
choices matter: nullish DTO defaults and render alternatives can elevate a score
without the same maintenance risk as stateful policy. Function span includes comments
and nested bodies while CC does not; never multiply span by CC to estimate removable
code. Nesting depth is a secondary syntactic indicator, not cognitive complexity.

`complexity-over-10.csv` retains all 343 function nodes above 10, across all three
classifications. `hotspots.md` enumerates all 52 runtime nodes above 20. Other
functions remain accounted for in per-file counts/maxima; reproduction emits their
full JSON inventory. The mean/percentiles do not substitute for domain review.

## Imports and modularity

Collect imports, re-exports, literal dynamic imports and literal `require` calls.
Resolve local `.js` paths to tracked `.ts/.tsx` and workspace exports to their source
entrypoint. Exclude whole-clause and per-specifier type-only declarations from the
value graph. Retain mixed declarations as value edges. Tarjan SCCs are calculated on
runtime files only; graph edges are static module dependencies, not call graphs.
Literal worker URLs and computed imports are not covered. Re-exports are conservative:
the scan does not model bundler tree shaking or when a dynamic import runs.

All local source/@quiz paths resolve. Four unresolved relative imports are known CSS
or SVG assets. Fan-in/out count distinct resolved runtime files, not import statements
or external packages. Area-level edge counts include repeated declarations and may
form aggregate cycles without file-level cycles. Shared barrels naturally have high
fan-in. Five file SCCs require interpretation; the schema component is retained.

## Exact clones

Flatten TypeScript syntax leaves, discarding comments (including JSDoc), whitespace
and EOF. Preserve token kind and exact identifier/literal text. Match windows of
**80 tokens**, verify equality after the rolling-hash lookup, expand equal runs in
both directions and deduplicate by occurrence start positions. Require each span to
cover at least six physical lines; discard overlapping occurrences in the same file.

Result: 14 **pairs**, not 14 independent abstraction opportunities. Pair spans can
overlap or involve the same common block in three files. The union covers 415 physical
lines in 19 files, including the originals that must remain. This does not measure
renamed/parameterized or semantic clones. No global duplication percentage or deletion
budget is inferred. Manual review accepts shared algorithms/policies and rejects
necessary schema envelopes, call-site prop plumbing and independent security checks.

## Reproduce

Use a clean detached worktree at the baseline and its frozen dependencies (TypeScript
6.0.3). The appendix is documentation of the analyzer, **not** an application/tooling
change installed into the project. Save the `javascript` fence below to `/tmp/measure.cjs`:

```sh
git ls-files > /tmp/quiz-code-audit-files.txt
AUDIT_TYPESCRIPT="$PWD/node_modules/typescript" \
AUDIT_FILES=/tmp/quiz-code-audit-files.txt \
AUDIT_OUT=/tmp/quiz-code-audit-data \
node /tmp/measure.cjs "$PWD"
```

Outputs are inventory/functions/imports/cycles/clones JSON. CSV columns are the JSON
fields; complexity CSV filters `cc > 10`; cycle CSV expands membership; area dependency
CSV groups runtime value-import declarations by distinct source/target areas. The
other-files inventory counts SQL/shell/Python/CSS/HTML/JSON/YAML/TOML and Docker/Caddy
configuration from the same tracked list. Do not run against a later HEAD and interpret
changed metrics as a regression without accounting for new features.

Sanity fixtures checked: straight-line1, outer-if2 plus independent inner-if2,
logical/nullish/assignment/ternary8, optional-chain1, loops/if/catch/cases/ternary9;
type-only mutual imports produce no value SCC. Comment-only changes do not count as
code tokens. Aggregate counts and every artifact/source location are checked again
when assembling this report. No performance benchmark or dynamic coverage measurement
is claimed.

## Analyzer appendix

```javascript
const fs=require('node:fs'),path=require('node:path');
const ts=require(process.env.AUDIT_TYPESCRIPT || path.join(process.cwd(),'node_modules/typescript'));
const root=process.argv[2],out=process.env.AUDIT_OUT || '/tmp/quiz-code-audit-data';process.chdir(root);fs.mkdirSync(out,{recursive:true});
const tracked=fs.readFileSync(process.env.AUDIT_FILES || '/tmp/quiz-code-audit-files.txt','utf8').trim().split('\n');
const files=tracked.filter(f=>/\.(?:[cm]?[jt]s|[jt]sx)$/.test(f));
function category(f){if(/(?:\/testing\.[jt]sx?$|\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__|__fixtures__|fixtures)(?:\/|$)|\/src\/mock\/)/.test(f))return'test';if(/\/src\/seed(?:\/|\.ts$)/.test(f))return'tooling';if(/^(apps|packages)\/[^/]+\/src\//.test(f)||/^extensions\//.test(f))return'runtime';return'tooling';}
function unit(f){let p=f.split('/');return /^(apps|packages|extensions)$/.test(p[0])?p.slice(0,2).join('/'):p[0];}
function area(f){let p=f.split('/');if(f.startsWith('apps/api/src/modules/'))return p.slice(0,p.length>5?5:4).join('/');if(/^apps\/(api|web)\/src\//.test(f))return p.length>4?p.slice(0,4).join('/'):p.slice(0,3).join('/');return unit(f);}
function fun(n){return (ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)||ts.isConstructorDeclaration(n))&&n.body;}
function fname(n,sf){if(n.name)return n.name.getText(sf);let p=n.parent;if(ts.isVariableDeclaration(p)||ts.isPropertyAssignment(p)||ts.isPropertyDeclaration(p))return p.name.getText(sf);if(ts.isCallExpression(p))return p.expression.getText(sf).slice(0,80)+' callback';return'<anonymous>';}
let inventory=[],functions=[],imports=[],sources=new Map(),tokens=new Map();
for(const file of files){let text=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),cat=category(file);sources.set(file,sf);
let row={file,category:cat,unit:unit(file),area:area(file),lines:text.split('\n').length-(text.endsWith('\n')?1:0),nonblank:text.split('\n').filter(x=>x.trim()).length,functions:0,max_cc:0,cc_gt10:0,cc_gt20:0,parse_errors:sf.parseDiagnostics.length};
function walk(n){if(fun(n)){let cc=1,maxDepth=0,branches=0;function count(x,depth){if(x!==n&&fun(x))return;let branch=ts.isIfStatement(x)||ts.isConditionalExpression(x)||ts.isForStatement(x)||ts.isForInStatement(x)||ts.isForOfStatement(x)||ts.isWhileStatement(x)||ts.isDoStatement(x)||ts.isCatchClause(x);let logical=ts.isBinaryExpression(x)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.AmpersandAmpersandEqualsToken,ts.SyntaxKind.BarBarEqualsToken,ts.SyntaxKind.QuestionQuestionEqualsToken].includes(x.operatorToken.kind);if(branch||logical||ts.isCaseClause(x))cc++;if(branch||ts.isSwitchStatement(x)){depth++;branches++;maxDepth=Math.max(maxDepth,depth);}ts.forEachChild(x,c=>count(c,depth));}count(n,0);let start=sf.getLineAndCharacterOfPosition(n.getStart(sf)),end=sf.getLineAndCharacterOfPosition(n.end);functions.push({file,category:cat,name:fname(n,sf),line:start.line+1,column:start.character+1,end_line:end.line+1,lines:end.line-start.line+1,cc,nesting:maxDepth});row.functions++;row.max_cc=Math.max(row.max_cc,cc);if(cc>10)row.cc_gt10++;if(cc>20)row.cc_gt20++;}
let spec,typeOnly=false;if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)){spec=n.moduleSpecifier?.text;typeOnly=!!n.isTypeOnly||!!n.importClause?.isTypeOnly;if(ts.isImportDeclaration(n)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings)&&!n.importClause.name&&n.importClause.namedBindings.elements.length)typeOnly ||= n.importClause.namedBindings.elements.every(e=>e.isTypeOnly);if(ts.isExportDeclaration(n)&&n.exportClause&&ts.isNamedExports(n.exportClause)&&n.exportClause.elements.length)typeOnly ||= n.exportClause.elements.every(e=>e.isTypeOnly);}
if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(sf)==='require')&&n.arguments.length===1&&ts.isStringLiteral(n.arguments[0]))spec=n.arguments[0].text;
if(spec)imports.push({from:file,spec,type_only:typeOnly,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1});ts.forEachChild(n,walk);}walk(sf);inventory.push(row);
{let a=[],codeLines=new Set();function leaves(n){if(n.kind>=ts.SyntaxKind.FirstJSDocNode&&n.kind<=ts.SyntaxKind.LastJSDocNode)return;let c=n.getChildren(sf);if(c.length)c.forEach(leaves);else if(n.kind!==ts.SyntaxKind.EndOfFileToken){let txt=n.getText(sf);if(txt.trim()){let line=sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;txt.split('\n').forEach((part,i)=>{if(part.trim())codeLines.add(line+i);});a.push({text:n.kind+':'+txt,line});}}}leaves(sf);row.code_lines=codeLines.size;if(cat==='runtime')tokens.set(file,a);}
}
const manifest={};for(let p of tracked.filter(f=>/^(apps|packages)\/[^/]+\/package.json$/.test(f))){let m=JSON.parse(fs.readFileSync(p));manifest[m.name]={dir:path.dirname(p),m};}
function candidate(base){for(let p of [base,base.replace(/\.js$/,'.ts'),base.replace(/\.js$/,'.tsx'),base+'.ts',base+'.tsx',base+'/index.ts',base+'/index.tsx'])if(sources.has(p))return p;return null;}
function resolve(i){if(i.spec.startsWith('.'))return candidate(path.posix.normalize(path.posix.join(path.posix.dirname(i.from),i.spec)));if(i.spec.startsWith('@quiz/')){let [scope,name,...rest]=i.spec.split('/'),p=manifest[scope+'/'+name];if(!p)return null;let key=rest.length?'./'+rest.join('/') : '.',e=p.m.exports?.[key];if(typeof e==='object')e=e.import??e.default??e.types;if(typeof e==='string')return candidate(path.posix.join(p.dir,e.replace('/dist/','/src/').replace(/\.d\.ts$/,'.ts')));return candidate(p.dir+'/src/'+(rest.join('/')||'index'));}return null;}
for(let i of imports){i.to=resolve(i);i.from_area=area(i.from);i.to_area=i.to?area(i.to):null;}
function scc(nodes,edges){let adj=new Map(nodes.map(x=>[x,[]]));for(let [a,b]of edges)if(adj.has(a)&&adj.has(b))adj.get(a).push(b);let at=0,stack=[],on=new Set(),idx=new Map(),low=new Map(),groups=[];function visit(v){idx.set(v,at);low.set(v,at++);stack.push(v);on.add(v);for(let w of adj.get(v)){if(!idx.has(w)){visit(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(on.has(w))low.set(v,Math.min(low.get(v),idx.get(w)));}if(low.get(v)===idx.get(v)){let g=[],w;do{w=stack.pop();on.delete(w);g.push(w);}while(w!==v);if(g.length>1)groups.push(g.sort());}}for(let n of nodes)if(!idx.has(n))visit(n);return groups.sort((a,b)=>b.length-a.length);}
const runtime=new Set(inventory.filter(x=>x.category==='runtime').map(x=>x.file));let edges=imports.filter(i=>!i.type_only&&runtime.has(i.from)&&runtime.has(i.to));let cycles=scc([...runtime],edges.map(i=>[i.from,i.to]));let areas=[...new Set([...runtime].map(area))],areaCycles=scc(areas,edges.filter(i=>i.from_area!==i.to_area).map(i=>[i.from_area,i.to_area]));
let incoming=new Map();for(let i of edges){if(!incoming.has(i.to))incoming.set(i.to,new Set());incoming.get(i.to).add(i.from);}for(let x of inventory){x.fan_in=incoming.get(x.file)?.size||0;x.fan_out=new Set(edges.filter(i=>i.from===x.file).map(i=>i.to)).size;}
function save(n,obj){fs.writeFileSync(out+'/'+n,JSON.stringify(obj,null,2)+'\n');}save('inventory.json',inventory);save('functions.json',functions);save('imports.json',imports);save('cycles.json',{file_cycles:cycles,area_cycles:areaCycles});
// Exact token clones, >=80 tokens and >=6 lines at each occurrence; comments/whitespace ignored.
const ids=new Map();let next=1;for(let [f,a]of tokens)for(let t of a){if(!ids.has(t.text))ids.set(t.text,next++);t.id=ids.get(t.text);delete t.text;}
let seen=new Map(),clones=new Map(),N=80,pow=1;for(let i=1;i<N;i++)pow=Math.imul(pow,31)>>>0;
for(let [f,a]of tokens){if(a.length<N)continue;let h=0;for(let i=0;i<N;i++)h=(Math.imul(h,31)+a[i].id)>>>0;for(let j=0;j<=a.length-N;j++){if(j>0)h=(Math.imul((h-Math.imul(a[j-1].id,pow))>>>0,31)+a[j+N-1].id)>>>0;let prev=seen.get(h)||[];for(let [g,k]of prev){if(f===g&&Math.abs(k-j)<N)continue;let b=tokens.get(g);if(!a.slice(j,j+N).every((t,z)=>t.id===b[k+z].id))continue;let l=0,r=N;while(j-l>0&&k-l>0&&a[j-l-1].id===b[k-l-1].id)l++;while(j+r<a.length&&k+r<b.length&&a[j+r].id===b[k+r].id)r++;if(f===g&&Math.abs(k-j)<r+l)continue;let al=a[j+r-1].line-a[j-l].line+1,bl=b[k+r-1].line-b[k-l].line+1;if(al<6||bl<6)continue;let key=[g,k-l,f,j-l].join(':');clones.set(key,{file_a:g,start_a:b[k-l].line,end_a:b[k+r-1].line,file_b:f,start_b:a[j-l].line,end_b:a[j+r-1].line,tokens:r+l});}
// Every occurrence retained; repeated windows inside an already-found run still deduplicate by start.
prev.push([f,j]);seen.set(h,prev);}}
save('clones.json',[...clones.values()].sort((a,b)=>b.tokens-a.tokens));
console.log(JSON.stringify({files:inventory.length,runtime_files:runtime.size,functions:functions.length,parse_errors:inventory.filter(x=>x.parse_errors),runtime_functions:functions.filter(x=>x.category==='runtime').length,clones:clones.size,file_cycles:cycles.length,area_cycles:areaCycles.length}));
```
