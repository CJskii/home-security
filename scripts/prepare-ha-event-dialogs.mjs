// Prepare an offline HA button-card variable; no deployment or credentials.
import process from'node:process';
import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';import ts from'typescript';
const root=resolve(process.argv[2]??'');if(!process.argv[2]||!root.startsWith(resolve('runtime')+'/'))throw Error('Pass runtime review directory');
const code=ts.transpileModule(readFileSync('web/src/integrations/ha-zone-dialog.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'');
if(/^import |^export /m.test(code))throw Error('Dialog must remain dependency free');
writeFileSync(root+'/history-variable.json',JSON.stringify('[[[\n'+code+'\nreturn {openZoneHistory,openEventDetails,activityText,activityCard,activityTime,relativeZoneTime,notificationLabel};\n]]]'),{mode:0o600});
