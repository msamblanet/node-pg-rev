# node-pg-rev - Revision History

- 2022-08-19: v0.4.2
  - Alter performLoad to return all count objects and job id/dates
  - Move AbstractTransformLoader into core module

- 2022-08-17: v0.4.1
  - Remove refresh from load_rev procedure, split out in procedure and in AsbtractRevLoader

- 2022-08-16: v0.4.0
  - Update to work with 0.4.0 generated tables
  - Sync version number

- 2022-08-01: v0.1.3
  - Fix withStream to allow for Readable and Writable

- 2022-07-25: v0.1.2
  - Change to using Readable streams instead of AsyncInterators to deal with stream closing issues

- 2022-07-25: v0.1.1
  - Added defaultFetchDate to processBatch and transformRecords (ensures date before running query is available to transform)

- 2022-07-24: v0.1.0 - Initial release
