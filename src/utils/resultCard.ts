/**
 * Ties a grid tile to the card it opens, in either results section.
 *
 * Its own module rather than a second export from the components file: a file that
 * exports both components and plain functions loses fast refresh, and both results
 * panels plus their cards need this id.
 */
export function resultCardElementId(jobId: string) {
  return `result-card-${jobId}`;
}
