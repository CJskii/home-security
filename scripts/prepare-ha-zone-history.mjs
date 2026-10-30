// Local proposal only. No HA writes, tokens, services or deployments.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {log} from 'node:console';
import process from 'node:process';
import ts from 'typescript';
const directory=resolve(process.argv[2]??'');
if(!process.argv[2]||!directory.startsWith(resolve('runtime')+'/'))throw Error('Pass a prepared runtime review directory');
const source=readFileSync('web/src/integrations/ha-zone-dialog.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'');
if(/^import |^export /m.test(code))throw Error('Dialog must remain dependency-free');
writeFileSync(directory+'/dialog-action.json',JSON.stringify({action:'javascript',javascript:'[[[\n'+code+'\nvoid openZoneHistory(hass,variables.channel,variables.slot);\n]]]'}),{mode:0o600});
log('Prepared native HA dialog action; no frontend resource installation required');
