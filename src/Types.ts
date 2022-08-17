//
// UPDATED TYPES
//
export interface UpdatedLoadRecord<PAYLOAD_TYPE, EXT_ID_TYPE> {
  ext_uid?: string;
  source_id?: string;
  ext_id?: EXT_ID_TYPE;
  raw_data?: PAYLOAD_TYPE;
  update_date: Date | string;
  notes?: string;
}

export interface UpdatedLoadResults {
  modified_count: number;
}

export interface UpdatedTrimResults {
  updated_trim_count: number;
}

//
// RAW TYPES
//
export interface RawLoadRecord<PAYLOAD_TYPE, EXT_ID_TYPE> {
  ext_uid?: string;
  ext_id?: EXT_ID_TYPE;
  source_id?: string;
  raw_data: PAYLOAD_TYPE;
  deleted?: boolean;
  fetch_date: Date | string;
  ext_create_date?: Date | string;
  ext_update_date?: Date | string;
}

export interface RawLoadResults {
  modified_count: number;
}

export interface RawTrimResults {
  raw_trim_count: number;
}

//
// REV TYPES
//
export interface RevLoadResults {
  load_count: number;
  missing_deletes_count: number;
  backlink_count: number;
}

export interface RevTrimResults {
  rev_trim_count: number;
}

//
// OTHER AbstractRevLoader TYPES
export type CurrentRefreshResults = Record<string, unknown>;

export interface IdResult<ID_TYPE> {
  id: ID_TYPE;
}

export interface ProcessBatchResults {
  records: number;
  modified: number;
}
