import { Readable } from 'node:stream';
import batch from 'it-batch';
import ms from 'ms';
import pg from 'pg';
import { withStream, poolStreamQuery } from './Util.js';
import { IdResult, ProcessBatchResults, RawLoadRecord, RawLoadResults, RawTrimResults, RevLoadResults, RevTrimResults, UpdatedTrimResults } from './Types.js';

export type TypedReadable<X> = Readable; // Add type to Readable for better documentation

export interface RevLoaderConfig {
  typeName: string; // The type name in the DB - include any namespaceing
  systemId?: string; // System ID - if not specifed, the default from the DB will be used
  loadRev: number; // Increment any time the source query or source schema changes
  pgBatchSize: number; // Batch size to write to Postgres - scale based on JSON size
  updateLimit: number; // Max number of records to read for full updates and delta ingests - Mainly used for testing
  outdatedLimit: number; // Max number of outdated records to process in a single run - used to avoid all at once hits to the system when loadRev changes
  revTrimAge?: string; // Null the raw data in rev table after this long (leave falsy to disable) - uses MS format - ignores current
  updatedTrimAge?: string; // Delete data in updated table after this long (leave falsy to disable) - uses MS format
  deleteMissing: boolean; // If true, load_rev will mark missing raw records as deleted by default
  refreshCurrentView: boolean; // If true, load_rev will refresh the _current view by default
  rawTrim: boolean;
}

export abstract class AbstractRevLoader<CONFIG_TYPE extends RevLoaderConfig, SOURCE_TYPE, RAW_TYPE, ID_TYPE> {
  public static DEFAULT_CONFIG: RevLoaderConfig = {
    typeName: '',
    loadRev: 0,
    pgBatchSize: 500,
    updateLimit: Number.MAX_SAFE_INTEGER,
    outdatedLimit: Number.MAX_SAFE_INTEGER,
    revTrimAge: '180d',
    updatedTrimAge: '180d',
    deleteMissing: true,
    refreshCurrentView: true,
    rawTrim: true
  };

  protected readonly config: CONFIG_TYPE;

  protected constructor(protected readonly revPool: pg.Pool, defaultConfig: CONFIG_TYPE, overrides?: Partial<CONFIG_TYPE>, protected readonly log: Console = console) {
    this.config = { ...defaultConfig, ...overrides };

    if (!this.config.typeName) {
      throw new Error('config.typeName must be set to a non-default value');
    }

    if (!this.config.loadRev) {
      throw new Error('config.loadRev must be set to a positive integer');
    }
  }

  public async performLoad(full = false, threshold?: Date) {
    const logName = this.config.typeName;

    try {
      this.log.time(logName);

      const rawTrimThreshold = new Date(); // @todo Can we enhance to use min fetchDate from load instead for more flexibility (such as loading from cached files)

      this.log.timeLog(logName, 'Load started', logName, full ? 'full' : 'delta', threshold, new Date());

      this.log.timeLog(logName, 'Loading updated');
      const updatedStart = new Date();
      const updated: ProcessBatchResults = { modified: 0, records: 0 };
      const updatedStream = await (full ? this.querySourceFull(this.config.updateLimit) : await this.querySourceDelta(this.config.updateLimit, threshold));
      await withStream(updatedStream, async updatedStream => this.processBatch(updatedStream, updatedStart, updated));
      this.log.timeLog(logName, 'Updated Results', updated);

      this.log.timeLog(logName, 'Refresh outdated');
      const outdatedStart = new Date();
      const outdated: ProcessBatchResults = { modified: 0, records: 0 };
      const outdatedStream = await this.queryOutdated(this.config.outdatedLimit);
      await withStream(outdatedStream, async outdatedStream => this.processBatch(outdatedStream, outdatedStart, outdated));
      this.log.timeLog(logName, 'Outdated Results', outdated);

      let rawTrimResults: RawTrimResults = { raw_trim_count: 0 };
      if (!full) {
        this.log.timeLog(logName, 'Trimming Raw SKIPPED - Requires full load');
      } else if (!this.config.rawTrim) {
        this.log.timeLog(logName, 'Trimming Raw SKIPPED - Disabled by config');
      } else if (updated.records >= this.config.updateLimit) {
        this.log.timeLog(logName, 'Trimming Raw SKIPPED - Update was limited');
      } else {
        this.log.timeLog(logName, 'Trimming Raw');
        rawTrimResults = await this.rawTrim(rawTrimThreshold);
        this.log.timeLog(logName, 'Trim Raw Results', rawTrimResults);
      }

      this.log.timeLog(logName, 'Loading Rev');
      const revLoadResults = await this.revLoad();
      this.log.timeLog(logName, 'Load Rev Results', revLoadResults);

      this.log.timeLog(logName, 'Trimming Rev');
      const revTrimResults = await this.revTrim();
      this.log.timeLog(logName, 'Trim Rev Results', revTrimResults);

      this.log.timeLog(logName, 'Trimming Updated');
      const updatedTrimResults = await this.updatedTrim();
      this.log.timeLog(logName, 'Trim Updated Results', updatedTrimResults);

      this.log.timeLog(logName, 'Load Complete', updated, outdated, rawTrimResults, revLoadResults, revTrimResults, updatedTrimResults);
    } finally {
      this.log.timeEnd(logName);
    }
  }

  protected async queryDefaultSystemId(): Promise<string | undefined> {
    const qr = await this.revPool.query(`SELECT ${this.config.typeName}_default_source_id() AS rv;`);
    const rv = qr.rows[0]?.rv as string | undefined;
    if (!rv) {
      throw new Error('Default system id not found');
    }

    return rv;
  }

  protected async queryLastFetchDate(): Promise<Date | undefined> {
    const qr = await this.revPool.query(`SELECT MAX(last_fetch_date) AS rv FROM ${this.config.typeName}_raw;`);
    if (qr.rowCount > 1) {
      throw new Error(`Invalid Row Count: ${qr.rowCount}`);
    }

    return qr.rows[0].rv as Date | undefined;
  }

  protected async queryLastExtUpdateDate(): Promise<Date | undefined> {
    const qr = await this.revPool.query(`SELECT MAX(ext_update_date) AS rv FROM ${this.config.typeName}_raw;`);
    if (qr.rowCount > 1) {
      throw new Error(`Invalid Row Count: ${qr.rowCount}`);
    }

    return qr.rows[0].rv as Date | undefined;
  }

  protected async queryLastUpdateDate(): Promise<Date | undefined> {
    const qr = await this.revPool.query(`SELECT MAX(update_date) AS rv FROM ${this.config.typeName}_raw;`);
    if (qr.rowCount > 1) {
      throw new Error(`Invalid Row Count: ${qr.rowCount}`);
    }

    return qr.rows[0].rv as Date | undefined;
  }

  protected async processBatch(dataIterator: TypedReadable<SOURCE_TYPE>, defaultFetchDate: Date, counts?: ProcessBatchResults): Promise<void> {
    counts ??= { modified: 0, records: 0 };

    const logInterval = setInterval(() => {
      this.log.timeLog(this.config.typeName, '...loading...', counts);
    }, 15_000);
    try {
      // Batch the records
      for await (const batched of batch(dataIterator, this.config.pgBatchSize)) {
        const updates = await this.transformRecords(batched, defaultFetchDate);
        const results = await this.revPool.query(
          `CALL ${this.config.typeName}_raw_load($1, $2, '{}'::JSONB)`, // Older Postgres does not support OUT so we need to use INOUT
          [this.config.loadRev, JSON.stringify(updates)]
        );

        const loadResult = results.rows[0].counts as RawLoadResults;
        counts.records += updates.length;
        counts.modified += loadResult.modified_count;
      }
    } finally {
      clearInterval(logInterval);
    }
  }

  protected buildOutdatedIdsQuery(useUid = true, limit = this.config.outdatedLimit): string {
    // Separate function because some tools may want to join to this via a with or something like that...
    return `
      -- Query anything with an outdated revision
      SELECT ${useUid ? 'ext_uid' : 'ext_id'} AS id
        FROM ${this.config.typeName}_raw
       WHERE NOT deleted
         AND data_rev <> ${this.config.loadRev}
       UNION
      -- Union everything which is new or outdated
      SELECT a.${useUid ? 'ext_uid' : 'ext_id'} AS id
        FROM ${this.config.typeName}_updated a
        LEFT JOIN ${this.config.typeName}_raw b ON a.ext_uid = b.ext_uid
       WHERE b.ext_uid IS NULL OR b.last_fetch_date < a.update_date
       LIMIT ${limit}`;
  }

  protected async queryOutdatedIds(useUid = true, limit = this.config.outdatedLimit): Promise<TypedReadable<IdResult<ID_TYPE>>> {
    const sql = this.buildOutdatedIdsQuery(useUid, limit);
    return poolStreamQuery(this.revPool, sql);
  }

  protected async rawTrim(startDate: Date): Promise<RawTrimResults> {
    const qr = await this.revPool.query(
      `CALL ${this.config.typeName}_raw_trim($1, '{}'::JSONB)`, // Older Postgres does not support OUT so we need to use INOUT
      [startDate]
    );

    return qr.rows[0].counts as RawTrimResults;
  }

  protected async revLoad(deleteMissing = this.config.deleteMissing, refreshCurrentView = this.config.refreshCurrentView): Promise<RevLoadResults> {
    const qr = await this.revPool.query(
      `CALL ${this.config.typeName}_rev_load($1, $2, '{}'::JSONB)`, // Older Postgres does not support OUT so we need to use INOUT
      [deleteMissing ? new Date() : null, refreshCurrentView]
    );

    return qr.rows[0].counts as RevLoadResults;
  }

  protected async revTrim(revTrimAge = this.config.revTrimAge): Promise<RevTrimResults> {
    if (revTrimAge) {
      const ageMillis = ms(revTrimAge);
      if (ageMillis > 0) {
        const cutoffDate = new Date(Date.now() - ageMillis);

        this.log.timeLog(this.config.typeName, 'Trim Revs Before', cutoffDate);

        const qr = await this.revPool.query(
          `CALL ${this.config.typeName}_rev_trim($1, '{}'::JSONB)`,
          [cutoffDate]
        );

        return qr.rows[0].counts as RevTrimResults;
      }
    }

    return { rev_trim_count: 0 };
  }

  protected async updatedTrim(updatedTrimAge = this.config.updatedTrimAge): Promise<UpdatedTrimResults> {
    if (updatedTrimAge) {
      const ageMillis = ms(updatedTrimAge);
      if (ageMillis > 0) {
        const cutoffDate = new Date(Date.now() - ageMillis);

        this.log.timeLog(this.config.typeName, 'Trim updated Before', cutoffDate);

        const qr = await this.revPool.query(
          `CALL ${this.config.typeName}_updated_trim($1, '{}'::JSONB)`,
          [cutoffDate]
        );

        return qr.rows[0].counts as UpdatedTrimResults;
      }
    }

    return { updated_trim_count: 0 };
  }

  protected async querySourceDelta(limit: number, _threshold?: Date): Promise<TypedReadable<SOURCE_TYPE>> {
    // Default implementation that defers to a full load
    this.log.timeLog(this.config.typeName, 'Delta not supported - performing full load');
    return this.querySourceFull(limit);
  }

  protected abstract querySourceFull(limit: number): Promise<TypedReadable<SOURCE_TYPE>>;
  protected abstract queryOutdated(limit: number): Promise<TypedReadable<SOURCE_TYPE>>;
  protected abstract transformRecords(data: SOURCE_TYPE[], defaultFetchDate: Date): Promise<Array<RawLoadRecord<RAW_TYPE, ID_TYPE>>>;
}

export default AbstractRevLoader;
