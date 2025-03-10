/* eslint-disable no-console */
/* eslint-disable valid-jsdoc */
/**
 * # Import
 *
 * @see startImport() for the primary entrypoint.
 *
 * ```
 *         openImport()
 *               | [user specifies import options or defaults]
 * closeImport() | startImport()
 *               | > cancelImport()
 * ```
 *
 * - [User actions for speficying import options] can be called once the modal has been opened
 * - Once `startImport()` has been called, [Import status action creators] are created internally
 *
 * NOTE: lucas: Any values intended for internal-use only, such as the action
 * creators for import status/progress, are called out with @api private
 * doc strings. This way, they can still be exported as needed for testing
 * without having to think deeply on whether they are being called from a top-level
 * action or not. Not great, but it has saved me a considerable amount of time vs.
 * larger scale refactoring/frameworks.
 */

import _ from 'lodash';
import { promisify } from 'util';
import fs from 'fs';
import type { AnyAction, Dispatch } from 'redux';
import type { ThunkAction, ThunkDispatch } from 'redux-thunk';

import PROCESS_STATUS from '../constants/process-status';
import FILE_TYPES from '../constants/file-types';
import { globalAppRegistryEmit, nsChanged } from './compass';
import type { ProcessStatus } from '../constants/process-status';
import type { RootImportState } from '../stores/import-store';
import type { AcceptedFileType } from '../constants/file-types';
import type { CollectionStreamProgress } from '../utils/collection-stream';
import type { CSVParsableFieldType } from '../utils/csv';
import type { ErrorJSON } from '../utils/import';
import { csvHeaderNameToFieldName } from '../utils/csv';
import { guessFileType } from '../import/guess-filetype';
import { listCSVFields } from '../import/list-csv-fields';
import { analyzeCSVFields } from '../import/analyze-csv-fields';
import type {
  AnalyzeCSVFieldsResult,
  CSVField,
} from '../import/analyze-csv-fields';
import { importCSV } from '../import/import-csv';
import { importJSON } from '../import/import-json';

import createLoggerAndTelemetry from '@mongodb-js/compass-logging';

const checkFileExists = promisify(fs.exists);
const getFileStats = promisify(fs.stat);

const { log, mongoLogId, debug, track } = createLoggerAndTelemetry(
  'COMPASS-IMPORT-EXPORT-UI'
);

/**
 * ## Action names
 */
const PREFIX = 'import-export/import';
export const STARTED = `${PREFIX}/STARTED`;
export const CANCELED = `${PREFIX}/CANCELED`;
export const GUESSTIMATED_PROGRESS = `${PREFIX}/GUESSTIMATED_PROGRESS`;
export const PROGRESS = `${PREFIX}/PROGRESS`;
export const FINISHED = `${PREFIX}/FINISHED`;
export const FAILED = `${PREFIX}/FAILED`;
export const FILE_TYPE_SELECTED = `${PREFIX}/FILE_TYPE_SELECTED`;
export const FILE_SELECTED = `${PREFIX}/FILE_SELECTED`;
export const OPEN = `${PREFIX}/OPEN`;
export const CLOSE = `${PREFIX}/CLOSE`;
export const OPEN_IN_PROGRESS_MESSAGE = `${PREFIX}/OPEN_IN_PROGRESS_MESSAGE`;
export const CLOSE_IN_PROGRESS_MESSAGE = `${PREFIX}/CLOSE_IN_PROGRESS_MESSAGE`;
export const SET_PREVIEW = `${PREFIX}/SET_PREVIEW`;
export const SET_DELIMITER = `${PREFIX}/SET_DELIMITER`;
export const SET_GUESSTIMATED_TOTAL = `${PREFIX}/SET_GUESSTIMATED_TOTAL`;
export const SET_STOP_ON_ERRORS = `${PREFIX}/SET_STOP_ON_ERRORS`;
export const SET_IGNORE_BLANKS = `${PREFIX}/SET_IGNORE_BLANKS`;
export const TOGGLE_INCLUDE_FIELD = `${PREFIX}/TOGGLE_INCLUDE_FIELD`;
export const SET_FIELD_TYPE = `${PREFIX}/SET_FIELD_TYPE`;
export const ANALYZE_STARTED = `${PREFIX}/ANALYZE_STARTED`;
export const ANALYZE_FINISHED = `${PREFIX}/ANALYZE_FINISHED`;
export const ANALYZE_FAILED = `${PREFIX}/ANALYZE_FAILED`;
export const ANALYZE_CANCELLED = `${PREFIX}/ANALYZE_CANCELLED`;

export type FieldFromCSV = {
  path: string;
  checked: boolean;
  type: CSVParsableFieldType;
  result?: CSVField;
};
type FieldFromJSON = {
  path: string;
  checked: boolean;
};
type PlaceholderField = {
  path: string;
  type: 'placeholder';
};
type FieldType = FieldFromJSON | FieldFromCSV | PlaceholderField;

export type CSVDelimiter = ',' | '\t' | ';' | ' ';

type State = {
  isOpen: boolean;
  isInProgressMessageOpen: boolean;
  errors: Error[];
  fileType: AcceptedFileType | '';
  fileName: string;
  fileIsMultilineJSON: boolean;
  useHeaderLines: boolean;
  status: ProcessStatus;

  fileStats: null | fs.Stats;
  docsTotal: number;
  docsProcessed: number;
  docsWritten: number;
  guesstimatedDocsTotal: number;
  guesstimatedDocsProcessed: number;
  delimiter: CSVDelimiter;
  stopOnErrors: boolean;

  ignoreBlanks: boolean;
  fields: FieldType[];
  values: string[][];
  previewLoaded: boolean;
  exclude: string[];
  transform: [string, CSVParsableFieldType][];

  abortController?: AbortController;
  analyzeAbortController?: AbortController;

  analyzeResult?: AnalyzeCSVFieldsResult;
  analyzeStatus: ProcessStatus;
  analyzeError?: Error;
};

export const INITIAL_STATE: State = {
  isOpen: false,
  isInProgressMessageOpen: false,
  errors: [],
  fileName: '',
  fileIsMultilineJSON: false,
  useHeaderLines: true,
  status: PROCESS_STATUS.UNSPECIFIED,
  fileStats: null,
  docsTotal: -1,
  docsProcessed: 0,
  docsWritten: 0,
  guesstimatedDocsTotal: 0,
  guesstimatedDocsProcessed: 0,
  delimiter: ',',
  stopOnErrors: false,
  ignoreBlanks: true,
  fields: [],
  values: [],
  previewLoaded: false,
  exclude: [],
  transform: [],
  fileType: '',
  analyzeStatus: PROCESS_STATUS.UNSPECIFIED,
};

/**
 * ### Import status action creators
 *
 * @see startImport below.
 *
 * ```
 * STARTED >
 * | *ERROR* || SET_GUESSTIMATED_TOTAL >
 *           | <-- PROGRESS -->
 *           | *FINISHED*
 * ```
 */

/**
 * @param {Number} progress
 * @param {Number} docsWritten
 * @api private
 */
export const onGuesstimatedProgress = (
  docsProcessed: number,
  docsTotal: number
) => ({
  type: GUESSTIMATED_PROGRESS,
  guesstimatedDocsProcessed: docsProcessed,
  guesstimatedDocsTotal: docsTotal,
});

export const onProgress = ({
  docsWritten,
  docsProcessed,
  errors,
}: CollectionStreamProgress) => ({
  type: PROGRESS,
  docsWritten,
  docsProcessed,
  errors,
});

export const onStarted = (abortController: AbortController) => ({
  type: STARTED,
  abortController,
});

export const onFinished = (docsWritten: number, docsTotal: number) => ({
  type: FINISHED,
  docsWritten,
  docsTotal,
});

export const onFailed = (error: Error) => ({ type: FAILED, error });

export const onGuesstimatedDocsTotal = (guesstimatedDocsTotal: number) => ({
  type: SET_GUESSTIMATED_TOTAL,
  guesstimatedDocsTotal: guesstimatedDocsTotal,
});

export const startImport = () => {
  return (
    dispatch: ThunkDispatch<RootImportState, void, AnyAction>,
    getState: () => RootImportState
  ) => {
    const startTime = Date.now();

    const state = getState();

    const { ns, importData } = state;

    const dataService = state.dataService.dataService!;

    const {
      fileName,
      fileType,
      fileIsMultilineJSON,
      fileStats,
      delimiter,
      ignoreBlanks: ignoreBlanks_,
      stopOnErrors,
      exclude,
      transform,
    } = importData;

    const ignoreBlanks = ignoreBlanks_ && fileType === FILE_TYPES.CSV;
    const fileSize = fileStats?.size || 0;

    const fields: Record<string, CSVParsableFieldType> = {};
    for (const [name, type] of transform) {
      if (exclude.includes(name)) {
        continue;
      }
      fields[name] = type;
    }

    const input = fs.createReadStream(fileName, 'utf8');

    log.info(
      mongoLogId(1001000080),
      'Import',
      'Start reading from source file',
      {
        ns,
        fileName,
        fileType,
        fileIsMultilineJSON,
        fileSize,
        delimiter,
        ignoreBlanks,
        stopOnErrors,
        exclude,
        transform,
      }
    );

    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    dispatch(onStarted(abortController));

    let promise;

    // TODO: log file, but probably only useful once we have the toast (COMPASS-6564)
    //const logPath = path.join(app.getPath('logs'), path.basename(fileName) + '.log');
    //const output = fs.createWriteStream(logPath);

    const errors: ErrorJSON[] = [];
    const errorCallback = (err: ErrorJSON) => {
      errors.push(err);
    };

    const progressCallback = _.throttle(function ({
      docsProcessed,
      docsWritten,
      bytesProcessed,
    }: {
      docsProcessed: number;
      docsWritten: number;
      bytesProcessed: number;
    }) {
      // for now, call onGuesstimatedDocsTotal() so that the existing progress bar works
      const averageSize = bytesProcessed / docsProcessed;
      const guessedTotal = Math.max(
        docsProcessed,
        Math.ceil(fileSize / averageSize)
      );
      dispatch(onGuesstimatedDocsTotal(guessedTotal));

      dispatch(onGuesstimatedProgress(docsProcessed, guessedTotal));

      dispatch(
        onProgress({
          docsWritten,
          docsProcessed,
          errors: errors.slice(), // make sure it is not the same variable
        })
      );
    },
    1000);

    if (fileType === 'csv') {
      promise = importCSV({
        dataService,
        ns,
        input,
        //output,
        delimiter,
        fields,
        abortSignal,
        progressCallback,
        errorCallback,
        stopOnErrors,
        ignoreEmptyStrings: ignoreBlanks,
      });
    } else {
      promise = importJSON({
        dataService: dataService,
        ns,
        input,
        //output,
        abortSignal,
        stopOnErrors,
        jsonVariant: fileIsMultilineJSON ? 'jsonl' : 'json',
        progressCallback,
        errorCallback,
      });
    }

    promise
      .finally(() => {
        progressCallback.flush();
      })
      .then((result) => {
        track('Import Completed', {
          duration: Date.now() - startTime,
          file_type: fileType,
          all_fields: exclude.length === 0,
          stop_on_error_selected: stopOnErrors,
          number_of_docs: result.docsWritten,
          success: true,
        });

        log.info(mongoLogId(1001000082), 'Import', 'Import completed', {
          ns,
          docsWritten: result.docsWritten,
          docsProcessed: result.docsProcessed,
        });

        dispatch(onFinished(result.docsWritten, result.docsProcessed));

        const payload = {
          ns,
          size: fileSize,
          fileType,
          docsWritten: result.docsWritten,
          fileIsMultilineJSON,
          delimiter,
          ignoreBlanks,
          stopOnErrors,
          hasExcluded: exclude.length > 0,
          hasTransformed: transform.length > 0,
        };
        dispatch(globalAppRegistryEmit('import-finished', payload));
      })
      .catch((err) => {
        dispatch(onFinished(err.result.docsWritten, err.result.docsProcessed));

        track('Import Completed', {
          duration: Date.now() - startTime,
          file_type: fileType,
          all_fields: exclude.length === 0,
          stop_on_error_selected: stopOnErrors,
          number_of_docs: err.result.docsWritten,
          success: !err,
        });

        log.error(mongoLogId(1001000081), 'Import', 'Import failed', {
          ns,
          docsWritten: err.result.docsWritten,
          error: err.message,
        });
        debug('Error while importing:', err.stack);

        return dispatch(onFailed(err));
      });
  };
};

/**
 * Cancels an active import if there is one, noop if not.
 *
 * @api public
 */
export const cancelImport = () => {
  return (
    dispatch: ThunkDispatch<RootImportState, void, AnyAction>,
    getState: () => RootImportState
  ) => {
    const { importData } = getState();
    const { abortController } = importData;

    if (abortController) {
      debug('cancelling');
      abortController.abort();
    } else {
      debug('no active import to cancel.');
      return;
    }

    debug('import canceled by user');
    dispatch({ type: CANCELED });
  };
};

const loadTypes = (
  fields: (FieldFromCSV | PlaceholderField)[],
  values: string[][]
): ThunkAction<Promise<void>, RootImportState, void, AnyAction> => {
  return async (
    dispatch: Dispatch,
    getState: () => RootImportState
  ): Promise<void> => {
    const { fileName, delimiter, ignoreBlanks } = getState().importData;

    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    dispatch({
      type: ANALYZE_STARTED,
      abortController,
    });

    const input = fs.createReadStream(fileName);

    try {
      const result = await analyzeCSVFields({
        input,
        delimiter,
        abortSignal,
        ignoreEmptyStrings: ignoreBlanks,
      });

      for (const unknownField of fields) {
        // fields are both CSV fields (where you can assign a type and decide
        // to include/exclude it) or placeholder ones.
        // ie. for foo[0] we'll show a type dropdown (labelled "foo") which
        // determines the types of all the elements in the array and for
        // foo[1] we just leave a placeholder.
        if ((unknownField as PlaceholderField).type === 'placeholder') {
          continue;
        }

        const csvField = unknownField as FieldFromCSV;

        let detected = result.fields[csvField.path].detected;
        if (detected === 'undefined') {
          // This is a bit of an edge case. If a column is always empty and
          // "Ignore empty strings" is checked, we'll detect "undefined".
          // We'll never actually insert undefined due to the checkbox, but
          // undefined as a bson type is deprecated so it might give the wrong
          // impression. We could select any type in the selectbox, so the
          // choice of making it null is arbitrary.
          detected = 'null';
        }

        csvField.type = detected;

        csvField.result = result.fields[csvField.path];
      }

      dispatch({
        type: SET_PREVIEW,
        fields,
        values,
      });

      dispatch({
        type: ANALYZE_FINISHED,
        result,
      });
    } catch (err) {
      log.error(
        mongoLogId(1_001_000_180),
        'Import',
        'Failed to analyze CSV fields',
        err
      );
      dispatch({
        type: ANALYZE_FAILED,
      });
    }
  };
};

const loadCSVPreviewDocs = (): ThunkAction<
  Promise<void>,
  RootImportState,
  void,
  AnyAction
> => {
  console.log('loading preview docs');
  return async (
    dispatch: ThunkDispatch<RootImportState, void, AnyAction>,
    getState: () => RootImportState
  ): Promise<void> => {
    const { fileName, delimiter, analyzeAbortController } =
      getState().importData;

    // if there's already an analyzeCSVFields in flight, abort that first
    if (analyzeAbortController) {
      analyzeAbortController.abort();
      dispatch({
        type: ANALYZE_CANCELLED,
      });
    }

    const input = fs.createReadStream(fileName);

    try {
      const result = await listCSVFields({ input, delimiter });
      const fieldMap: Record<string, true> = {};

      const fields = result.headerFields.map(
        (name): FieldFromCSV | PlaceholderField => {
          const uniqueName = csvHeaderNameToFieldName(name);
          // we already have a field for this flattened/unique name.
          // (ie. this is an item inside an array and it is not the first
          // element in that array)
          if (fieldMap[uniqueName]) {
            return {
              path: name,
              type: 'placeholder',
            };
          }

          fieldMap[uniqueName] = true;

          return {
            path: uniqueName,
            checked: true,
            type: 'mixed', // will be detected by analyzeCSVFields
          };
        }
      );

      const values = result.preview;

      dispatch({
        type: SET_PREVIEW,
        fields,
        values,
      });

      await dispatch(loadTypes(fields, values));
    } catch (err) {
      log.error(
        mongoLogId(1001000097),
        'Import',
        'Failed to load preview docs',
        err
      );
    }
  };
};

/**
 * ### User actions for speficying import options
 */

/**
 * Mark a field to be included or excluded from the import.
 *
 * @param {String} path Dot notation path of the field.
 * @api public
 */
export const toggleIncludeField = (path: string) => ({
  type: TOGGLE_INCLUDE_FIELD,
  path: path,
});

/**
 * Specify the `type` values at `path` should be cast to.
 *
 * @param {String} path Dot notation accessor for value.
 * @param {String} bsonType A bson type identifier.
 * @example
 * ```javascript
 * //  Cast string _id from a csv to a bson.ObjectId
 * setFieldType('_id', 'ObjectId');
 * // Cast `{stats: {flufiness: "100"}}` to
 * // `{stats: {flufiness: 100}}`
 * setFieldType('stats.flufiness', 'Int32');
 * ```
 */
export const setFieldType = (path: string, bsonType: string) => {
  return {
    type: SET_FIELD_TYPE,
    path: path,
    bsonType: bsonType,
  };
};

export const selectImportFileName = (fileName: string) => {
  return async (dispatch: ThunkDispatch<RootImportState, void, AnyAction>) => {
    try {
      const exists = await checkFileExists(fileName);
      if (!exists) {
        throw new Error(`File ${fileName} not found`);
      }
      const fileStats = await getFileStats(fileName);

      const input = fs.createReadStream(fileName, 'utf8');
      const detected = await guessFileType({ input });

      if (detected.type === 'unknown') {
        throw new Error('Cannot determine the file type');
      }

      debug('get detection results', detected);

      // This is temporary. The store should just work with one fileType var
      const fileIsMultilineJSON = detected.type === 'jsonl';
      const fileType = detected.type === 'jsonl' ? 'json' : detected.type;

      dispatch({
        type: FILE_SELECTED,
        delimiter: detected.type === 'csv' ? detected.csvDelimiter : undefined,
        fileName,
        fileStats,
        fileIsMultilineJSON,
        fileType,
      });

      // We only ever display preview rows for CSV files underneath the field
      // type selects
      if (detected.type === 'csv') {
        await dispatch(loadCSVPreviewDocs());
      }
    } catch (err: any) {
      debug('dispatching error', err?.stack);
      dispatch(onFailed(err));
    }
  };
};

/**
 * Set the tabular delimiter.
 */
export const setDelimiter = (delimiter: CSVDelimiter) => {
  return async (
    dispatch: ThunkDispatch<RootImportState, void, AnyAction>,
    getState: () => RootImportState
  ) => {
    const { fileName, fileType, fileIsMultilineJSON } = getState().importData;
    dispatch({
      type: SET_DELIMITER,
      delimiter: delimiter,
    });

    // NOTE: The preview could still be loading and then we'll have two
    // loadCSVPreviewDocs() actions being dispatched simultaneously. The newer
    // one should finish last and just override whatever the previous one gets,
    // so hopefully fine.
    if (fileType === 'csv') {
      debug('preview needs updating because delimiter changed', {
        fileName,
        fileType,
        delimiter,
        fileIsMultilineJSON,
      });
      await dispatch(loadCSVPreviewDocs());
    }
  };
};

/**
 * Stop the import if mongo returns an error for a document write
 * such as a duplicate key for a unique index. In practice,
 * the cases for this being false when importing are very minimal.
 * For example, a duplicate unique key on _id is almost always caused
 * by the user attempting to resume from a previous import without
 * removing all documents sucessfully imported.
 *
 * @see utils/collection-stream.js
 * @see https://www.mongodb.com/docs/database-tools/mongoimport/#std-option-mongoimport.--stopOnError
 */
export const setStopOnErrors = (stopOnErrors: boolean) => ({
  type: SET_STOP_ON_ERRORS,
  stopOnErrors: stopOnErrors,
});

/**
 * Any `value` that is `''` will not have this field set in the final
 * document written to mongo.
 *
 * @see https://www.mongodb.com/docs/database-tools/mongoimport/#std-option-mongoimport.--ignoreBlanks
 */
export const setIgnoreBlanks = (ignoreBlanks: boolean) => ({
  type: SET_IGNORE_BLANKS,
  ignoreBlanks: ignoreBlanks,
});

/**
 * ### Top-level modal visibility
 */

/**
 * Open the import modal.
 */
export const openImport = (namespace: string) => {
  return (
    dispatch: ThunkDispatch<RootImportState, void, AnyAction>,
    getState: () => RootImportState
  ) => {
    // TODO(COMPASS-6540): Once we have importing in the background
    // we'll need to update how we check if an import is in progress here.
    const { status } = getState().importData;
    if (status === 'STARTED') {
      dispatch({
        type: OPEN_IN_PROGRESS_MESSAGE,
      });
      return;
    }

    track('Import Opened');
    dispatch(nsChanged(namespace));
    dispatch({ type: OPEN });
  };
};

/**
 * Close the import modal.
 * @api public
 */
export const closeImport = () => ({
  type: CLOSE,
});

export const closeInProgressMessage = () => ({
  type: CLOSE_IN_PROGRESS_MESSAGE,
});

function nonPlaceholderFields(
  fields: FieldType[]
): (FieldFromCSV | FieldFromJSON)[] {
  return fields.filter(
    (field) => (field as PlaceholderField).type !== 'placeholder'
  ) as unknown as (FieldFromCSV | FieldFromJSON)[];
}

function csvFields(
  fields: (FieldFromCSV | FieldFromJSON | PlaceholderField)[]
): FieldFromCSV[] {
  return fields.filter(
    (field) =>
      (field as PlaceholderField).type !== 'placeholder' &&
      (field as FieldFromCSV).type !== undefined
  ) as unknown as FieldFromCSV[];
}

/**
 * The import module reducer.
 */
const reducer = (state = INITIAL_STATE, action: AnyAction): State => {
  if (action.type === FILE_SELECTED) {
    return {
      ...state,
      delimiter: action.delimiter,
      fileName: action.fileName,
      fileType: action.fileType,
      fileStats: action.fileStats,
      fileIsMultilineJSON: action.fileIsMultilineJSON,
      status: PROCESS_STATUS.UNSPECIFIED,
      docsTotal: -1,
      docsProcessed: 0,
      docsWritten: 0,
      guesstimatedDocsTotal: 0,
      guesstimatedDocsProcessed: 0,
      errors: [],
      abortController: undefined,
      analyzeAbortController: undefined,
      fields: [],
    };
  }

  /**
   * ## Options
   */
  if (action.type === FILE_TYPE_SELECTED) {
    return {
      ...state,
      fileType: action.fileType,
    };
  }

  if (action.type === SET_STOP_ON_ERRORS) {
    return {
      ...state,
      stopOnErrors: action.stopOnErrors,
    };
  }

  if (action.type === SET_IGNORE_BLANKS) {
    return {
      ...state,
      ignoreBlanks: action.ignoreBlanks,
    };
  }

  if (action.type === SET_DELIMITER) {
    return {
      ...state,
      delimiter: action.delimiter,
    };
  }

  /**
   * ## Preview and projection/data type options
   */
  if (action.type === SET_PREVIEW) {
    const newState = {
      ...state,
      values: action.values,
      fields: action.fields,
      previewLoaded: true,
      exclude: [],
    };

    newState.transform = (
      newState.fields as (FieldFromCSV | PlaceholderField)[]
    )
      .filter((field) => field.type !== 'placeholder' && field.checked)
      .map((field) => [field.path, field.type as CSVParsableFieldType]);

    return newState;
  }
  /**
   * When checkbox next to a field is checked/unchecked
   */
  if (action.type === TOGGLE_INCLUDE_FIELD) {
    const newState = {
      ...state,
    };

    newState.fields = newState.fields.map((field) => {
      // you can't toggle a placeholder field
      field = field as FieldFromCSV | FieldFromJSON;

      if (field.path === action.path) {
        field.checked = !field.checked;
      }
      return field;
    });

    newState.transform = csvFields(newState.fields).map((field) => [
      field.path,
      field.type,
    ]);

    newState.exclude = nonPlaceholderFields(newState.fields)
      .filter((field) => !field.checked)
      .map((field) => field.path);

    return newState;
  }

  /**
   * Changing field type from a select dropdown.
   */
  if (action.type === SET_FIELD_TYPE) {
    const newState = {
      ...state,
    };

    newState.fields = newState.fields.map((field) => {
      if (field.path === action.path) {
        // you can only set the type of a csv field
        const csvField = field as FieldFromCSV;

        // If a user changes a field type, automatically check it for them
        // so they don't need an extra click or forget to click it an get frustrated
        // like I did so many times :)
        csvField.checked = true;
        csvField.type = action.bsonType;

        return csvField;
      }

      return field;
    });

    newState.transform = csvFields(newState.fields)
      .filter((field) => field.checked)
      .map((field) => [field.path, field.type]);

    newState.exclude = nonPlaceholderFields(newState.fields)
      .filter((field) => !field.checked)
      .map((field) => field.path);

    return newState;
  }

  /**
   * ## Status/Progress
   */
  if (action.type === FAILED) {
    return {
      ...state,
      // In cases where `FAILED` happened on import it might emit an event with
      // an error that was already saved in the `errors` array. We want to avoid
      // that by checking if the error is there before storing it in the state
      errors: state.errors.includes(action.error)
        ? state.errors
        : state.errors.concat(action.error),
      status: PROCESS_STATUS.FAILED,
    };
  }

  if (action.type === STARTED) {
    return {
      ...state,
      errors: [],
      docsTotal: -1,
      docsProcessed: 0,
      docsWritten: 0,
      guesstimatedDocsTotal: 0,
      guesstimatedDocsProcessed: 0,
      status: PROCESS_STATUS.STARTED,
      abortController: action.abortController,
    };
  }

  if (action.type === SET_GUESSTIMATED_TOTAL) {
    return {
      ...state,
      guesstimatedDocsTotal: action.guesstimatedDocsTotal,
    };
  }

  if (action.type === GUESSTIMATED_PROGRESS) {
    return {
      ...state,
      guesstimatedDocsProcessed: action.guesstimatedDocsProcessed,
      guesstimatedDocsTotal: action.guesstimatedDocsTotal,
    };
  }

  if (action.type === PROGRESS) {
    return {
      ...state,
      docsWritten: action.docsWritten,
      docsProcessed: action.docsProcessed,
      errors: action.errors,
    };
  }

  if (action.type === FINISHED) {
    const isComplete = state.status !== PROCESS_STATUS.CANCELED;
    const hasErrors = (state.errors || []).length > 0;

    let status = state.status;

    if (isComplete && hasErrors) {
      status = PROCESS_STATUS.COMPLETED_WITH_ERRORS;
    } else if (isComplete) {
      status = PROCESS_STATUS.COMPLETED;
    }

    return {
      ...state,
      status,
      docsWritten: action.docsWritten,
      docsTotal: action.docsTotal,
      abortController: undefined,
    };
  }

  if (action.type === CANCELED) {
    return {
      ...state,
      status: PROCESS_STATUS.CANCELED,
      abortController: undefined,
    };
  }

  if (action.type === OPEN) {
    return {
      ...INITIAL_STATE,
      isOpen: true,
    };
  }

  if (action.type === CLOSE) {
    return {
      ...state,
      isOpen: false,
    };
  }

  if (action.type === OPEN_IN_PROGRESS_MESSAGE) {
    return {
      ...state,
      isInProgressMessageOpen: true,
    };
  }

  if (action.type === CLOSE_IN_PROGRESS_MESSAGE) {
    return {
      ...state,
      isInProgressMessageOpen: false,
    };
  }

  if (action.type === ANALYZE_STARTED) {
    return {
      ...state,
      analyzeStatus: PROCESS_STATUS.STARTED,
      analyzeAbortController: action.abortController,
      analyzeError: undefined,
    };
  }
  if (action.type === ANALYZE_FINISHED) {
    return {
      ...state,
      analyzeStatus: PROCESS_STATUS.COMPLETED,
      analyzeAbortController: undefined,
      analyzeResult: action.result,
      analyzeError: undefined,
    };
  }
  if (action.type === ANALYZE_FAILED) {
    return {
      ...state,
      analyzeStatus: PROCESS_STATUS.FAILED,
      analyzeAbortController: undefined,
      analyzeError: action.error,
    };
  }
  if (action.type === ANALYZE_CANCELLED) {
    return {
      ...state,
      analyzeStatus: PROCESS_STATUS.CANCELED,
      analyzeAbortController: undefined,
      analyzeError: undefined,
    };
  }

  return state;
};
export default reducer;
