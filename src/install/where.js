import { join } from 'node:path';

// Where an installation is. One place, so the doctor and the self-check can never diagnose a folder that is not the
// one the installer wrote.
//
// The record of an installation names the folder it was placed in (`path`) and the folder its records live in
// (`destination`). A record of an old shape may name neither: the installer places an installation in
// `<destination>/<version>-<client>`, so that is where it is, and the record of it is where the record says.

/**
 * The folder where the records of an installation live: the one the record names, or the one of the configuration
 * when the record names none (a custom `--dest` or a moved installation is the record's own folder).
 *
 * @param {object} record the installation record
 * @param {string} fallback the folder of the configuration (the default)
 * @returns {string} the folder of the records
 */
export function destinationOf(record, fallback) {
  const named = record?.destination;
  return typeof named === 'string' && named !== '' ? named : fallback;
}

/**
 * The folder of an installation: the one the record names, or the one the installer places it in
 * (`<destination>/<version>-<client>`), when the record names none.
 *
 * @param {object} record the installation record
 * @param {string} destination the folder where the records live
 * @returns {string|undefined} the folder of the installation, or undefined when it cannot be told
 */
export function installationOf(record, destination) {
  const named = record?.path;
  if (typeof named === 'string' && named !== '') return named;
  const { version, client } = record ?? {};
  if (typeof version === 'string' && version !== '' && typeof client === 'string' && client !== '' && destination) {
    return join(destination, `${version}-${client}`);
  }
  return undefined;
}

/**
 * The record of an installation with the folder of the installation and the folder of its records filled in: the
 * doctor and the self-check diagnose the installation that is really there.
 *
 * @param {object} record the installation record (as written)
 * @param {string} fallback the folder of the configuration (the default)
 * @returns {object} the record with its folders
 */
export function resolvedRecord(record, fallback) {
  const destination = destinationOf(record, fallback);
  const path = installationOf(record, destination);
  return { ...record, destination, ...(path === undefined ? {} : { path }) };
}
