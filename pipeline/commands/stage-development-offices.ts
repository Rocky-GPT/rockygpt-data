import { DevelopmentCandidateValidationError, stageDevelopmentOfficeCandidate } from '../development-office-candidate';

const args = process.argv.slice(2);
const allowed = new Set(['--source-url', '--candidate', '--version', '--capture-directory', '--report']);
const values = new Map<string,string>();
for (let index=0; index<args.length; index+=2) {
  const [key,value]=args.slice(index,index+2);
  if (!allowed.has(key) || !value || values.has(key)) throw new Error('Explicit source URL, candidate, version, capture directory and report are required.');
  values.set(key,value);
}
if (values.size !== allowed.size) throw new Error('Missing development staging arguments.');
void stageDevelopmentOfficeCandidate({ sourceUrl:values.get('--source-url')!, candidate:values.get('--candidate')!,
  version:values.get('--version')!,captureDirectory:values.get('--capture-directory')!,reportPath:values.get('--report')! })
  .then(report=>console.log(JSON.stringify(report,null,2)))
  .catch(error=>{
    // Database diagnostics can contain connection arguments. Never log them.
    const code=typeof error?.code==='string' && /^[0-9A-Z]{5}$/.test(error.code)?` (database code ${error.code})`:'';
    console.error(error instanceof DevelopmentCandidateValidationError ? error.message : `Development candidate staging failed${code}; inspect validation and local database state without exposing connection credentials.`);
    process.exitCode=1;
  });
