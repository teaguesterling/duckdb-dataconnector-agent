import { Config } from "./config";
import { DB_ALLOW_LIST, DB_CREATE, DB_PRIVATECACHE, DB_READONLY } from "./environment";
import SQLite from 'sqlite3';
import { 
    Database, DuckDbError, 
    OPEN_CREATE, 
    OPEN_READONLY, OPEN_READWRITE, 
    OPEN_PRIVATECACHE, OPEN_SHAREDCACHE 
} from 'duckdb';

export type SqlLogger = (sql: string) => void

// See https://github.com/TryGhost/node-sqlite3/wiki/API#new-sqlite3databasefilename--mode--callback
// mode (optional): One or more of OPEN_READONLY | OPEN_READWRITE | OPEN_CREATE | OPEN_FULLMUTEX | OPEN_URI | OPEN_SHAREDCACHE | OPEN_PRIVATECACHE
// The default value is OPEN_READWRITE | OPEN_CREATE | OPEN_FULLMUTEX.
const readMode   = DB_READONLY     ? OPEN_READONLY     : OPEN_READWRITE;
const createMode = DB_CREATE       ? OPEN_CREATE       : 0; // Flag style means 0=off
const cacheMode  = DB_PRIVATECACHE ? OPEN_PRIVATECACHE : OPEN_SHAREDCACHE;
export const defaultMode = readMode | createMode | cacheMode;
export const createDbMode = OPEN_CREATE | readMode | cacheMode;

export type Connection = {
  query: (query: string, params?: Record<string, unknown>) => Promise<Array<any>>,
  exec: (sql: string) => Promise<void>;
  withTransaction: <Result>(action: () => Promise<Result>) => Promise<Result>
}

export async function withConnection<Result>(config: Config, mode: number, sqlLogger: SqlLogger, useConnection: (connection: Connection) => Promise<Result>): Promise<Result> {
  if(DB_ALLOW_LIST != null) {
    if(DB_ALLOW_LIST.includes(config.db)) {
      throw new Error(`Database ${config.db} is not present in DB_ALLOW_LIST 😭`);
    }
  }

  const dbt = new Database(':memory:', {
      "access_mode": "READ_WRITE",
      "max_memory": "512MB",
      "threads": "4"
  }, (err:any) => {
    if (err) {
      console.error(err);
    }
  });
  console.error("Conn:", dbt);

  const x = dbt.all(
    'SELECT ?::INTEGER AS fortytwo, ?::STRING AS hello', 42, 'Hello, World', 
    function(err:any, res:any) {
    if (err) {
      console.warn("Error", err);
      return;
    }
    console.log("42:", res[0].fortytwo)
    console.log("hello", res[0].hello)
  });
  console.log("Starting");

  const db_ = await new Promise<Database>((resolve, reject) => {
    console.log("Connecting to", config.db, "with: ", config.init);
    const params = {"access_mode": "READ_WRITE"};
    const db = new Database(config.db, params, conn_err => {
      console.log("Connection Result:", conn_err);
      if (conn_err) {
        reject(conn_err);
      //} else if(config.init) {
      //  db.exec(config.init, (init_err: any, res: any) => {
      //    console.log("Init Result:", init_err);
      //    if(init_err) {
      //     reject(init_err);
      //    } else {
		  //     resolve(db);
		  //    }
      //  });
      } else {
        resolve(db);
      }
      //
    });
    console.log("Resolving:", db);
    resolve(db);
  });


  // NOTE: Avoiding util.promisify as this seems to be causing connection failures.
  const query = (query: string, params?: Record<string, unknown>): Promise<Array<any>> => {
    return new Promise((resolve, reject) => {
      /* Pass named params:
       * db.run("UPDATE tbl SET name = $name WHERE id = $id", {
       *   $id: 2,
       *   $name: "bar"
       * });
       */
      sqlLogger(query);
      db_.all(query, params || {}, (err: any, data: any) => {
        if (err) {
          return reject(err);
        } else {
          resolve(data);
        }
      })
    })
  }

  const exec = (sql: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      sqlLogger(sql);
      db_.exec(sql, (err : any) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      })
    })
  };

  const withTransaction = async <Result>(action: () => Promise<Result>): Promise<Result> => {
    await exec("BEGIN TRANSACTION");
    try {
      const result = await action();
      await exec("COMMIT");
      return result;
    } catch (err) {
      await exec("ROLLBACK")
      throw err;
    }
  }

  try {
    return await useConnection({ query, exec, withTransaction });
  }
  finally {
    await new Promise((resolve, reject) => {
      db_.close();
      return;
      //db_.close((err: any) => {
      //  if (err) {
      //    return reject(err);
      //  } else {
      //    resolve(true); // What should we resolve with if there's no data to promise?
      //  }
      //})
    });
  }
}
