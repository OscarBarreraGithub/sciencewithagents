import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  groupBetaProfileSchema,
  groupBetaSigningBytes,
  encodeGroupBetaAdmission,
  encodeGroupBetaSetupCode,
  groupBetaEncode,
  groupBetaDecode,
} from '../packages/shared/dist/group-beta-admission.js';

function privateDirectory(directory) {
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
    throw new Error('Private operator directory required.');
}
function save(path, value) {
  privateDirectory(dirname(path));
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}
function readOperator(path) {
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid() ||
      st.mode & 0o077 ||
      st.size > 8192
    )
      throw new Error('Private operator key file required.');
    const raw = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      raw.version !== 1 ||
      typeof raw.privateKeyPkcs8 !== 'string' ||
      Object.keys(raw).sort().join(',') !== 'privateKeyPkcs8,profile,version'
    )
      throw new Error('Invalid operator key.');
    return {
      profile: groupBetaProfileSchema.parse(raw.profile),
      privateKeyPkcs8: raw.privateKeyPkcs8,
    };
  } finally {
    closeSync(fd);
  }
}
/** Offline owner operation only. No network, provider launch or deployment. */
export async function keygen(directory, origin, serviceId, endpointId = serviceId) {
  directory = resolve(directory);
  privateDirectory(dirname(directory));
  mkdirSync(directory, { mode: 0o700 }); // Refuse every existing destination.
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
    'hex',
  );
  const profile = groupBetaProfileSchema.parse({
    version: 1,
    serviceId,
    endpointId,
    origin,
    keys: [{ kid: randomBytes(8).toString('hex'), publicKey, state: 'create+route' }],
  });
  const privateKeyPkcs8 = groupBetaEncode(
    new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  );
  const privateKeyFile = join(directory, 'operator-key.json');
  const publicProfileFile = join(directory, 'public-profile.json');
  save(privateKeyFile, JSON.stringify({ version: 1, profile, privateKeyPkcs8 }) + '\n');
  save(publicProfileFile, JSON.stringify(profile, null, 2) + '\n');
  return { privateKeyFile, publicProfileFile };
}
export async function issue(operatorFile, outputFile, validMinutes = 1440) {
  if (!Number.isSafeInteger(validMinutes) || validMinutes < 1 || validMinutes > 90 * 1440)
    throw new Error('Creation validity must be between one minute and ninety days.');
  const operator = readOperator(resolve(operatorFile));
  const key = operator.profile.keys.find((k) => k.state === 'create+route');
  if (!key) throw new Error('No creation key configured.');
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    groupBetaDecode(operator.privateKeyPkcs8),
    'Ed25519',
    false,
    ['sign'],
  );
  const createCapability = randomBytes(32).toString('hex');
  const createOperationId = randomUUID();
  const createCapabilityHash = createHash('sha256')
    .update(`dock-group-setup-v1:${createCapability}`)
    .digest('hex');
  const h = createHash('sha256')
    .update(JSON.stringify(['dock-group-id-v1', createCapabilityHash, createOperationId]))
    .digest('hex');
  const groupId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const issuedAt = Date.now();
  const payload = {
    version: 1,
    serviceId: operator.profile.serviceId,
    kid: key.kid,
    groupId,
    createOperationId,
    createCapabilityHash,
    issuedAt,
    createExpiresAt: issuedAt + validMinutes * 60_000,
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', privateKey, groupBetaSigningBytes(payload)),
  );
  const admission = encodeGroupBetaAdmission(payload, signature);
  // Catch an accidentally mismatched private/public key without emitting a useless code.
  const { verifyGroupBetaAdmission } = await import(
    '../packages/shared/dist/group-beta-admission.js'
  );
  await verifyGroupBetaAdmission(admission, operator.profile);
  save(
    resolve(outputFile),
    encodeGroupBetaSetupCode({ version: 1, admission, createCapability }) + '\n',
  );
  return { outputFile: resolve(outputFile), groupId, createExpiresAt: payload.createExpiresAt };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === 'keygen' && (args.length === 3 || args.length === 4))
      result = await keygen(...args);
    else if (command === 'issue' && (args.length === 2 || args.length === 3))
      result = await issue(args[0], args[1], args[2] === undefined ? 1440 : Number(args[2]));
    else throw new Error('Invalid command.');
    // Paths/public metadata only; never print the signing key or setup code.
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write(
      'Groups beta operator command failed. Check private files and arguments; nothing was deployed.\n',
    );
    process.exitCode = 1;
  }
}
