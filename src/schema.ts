import { SchemaResponse, ColumnInfo, TableInfo, Constraint, ColumnValueGenerationStrategy, SchemaRequest, DetailLevel, TableName } from "@hasura/dc-api-types"
import { ScalarTypeKey } from "./capabilities";
import { Config } from "./config";
import { defaultMode, SqlLogger, withConnection } from './db';
import { MUTATIONS } from "./environment";
import { unreachable } from "./util";

var sqliteParser = require('sqlite-parser');

const DUCKDB_SCHEMA_QUERY = `
WITH 
tables_and_views AS (
  SELECT 
      'VIEW' AS table_type, 
      view_name AS table_name, 
      view_oid AS table_oid,
      "comment" AS table_comment,
      * EXCLUDE (view_name, view_oid, "comment") 
    FROM duckdb_views() 
  UNION BY NAME 
  SELECT 
      'TABLE' AS table_type, 
      "comment" AS table_comment,
      * 
    FROM duckdb_tables()
  ),
columns_with_types AS (
  SELECT
    * EXCLUDE ( 
        data_type, data_type_id, 
        "comment", "internal", 
        database_name, schema_name, table_name 
    ),
    cols."comment" AS column_comment,
    cols."internal" AS internal_column,
    struct_pack(
      type_name := cols.data_type,
      type_ddl := cs.data_type,
      logical_type := logical_type,
      type_category := type_category
    ) AS data_type
  FROM duckdb_columns() AS cols
  JOIN duckdb_types() AS types ON data_type_id=type_oid
  JOIN information_schema.columns AS cs 
    ON cols.database_name=cs.table_catalog
    AND cols.schema_name=cs.table_schema
    AND cols.table_name=cs.table_name
    AND cols.column_name=cs.column_name
)
SELECT 
  database_name,
  schema_name,
  table_name,
  table_type,
  table_comment,
  "temporary" AS is_temporary,
  "internal" AS internal_table,
  has_primary_key,
  list(struct_pack(
    column_name := column_name,
    internal_column := internal_column,
    column_comment := column_comment,
    is_nullable := is_nullable,
    is_generated := is_generated,
    data_type := data_type
  )) AS table_columns
FROM tables_and_views
JOIN columns_with_types USING (database_oid, schema_oid, table_oid)
GROUP BY ALL;
`;

type TableTypeInternal = "TABLE" | "VIEW";

type DataType = {
  type_name: string,
  logical_type: string,
  type_category: string,
  type_ddl: string
};

type NestedConstraintInfoInternal = {};

type NestedColumnInfoInternal = {
  column_name: string,
  internal_column: boolean,
  column_comment: string,
  is_nullable: Number,
  is_generated: Number,
  data_type: DataType
  //constraints: Array<NestedConstraintInfoInternal>
};

type TableInfoInternal = {
  database_name: string,
  schema_name: string,
  table_name: string,
  table_type: TableTypeInternal,
  is_temporary: boolean,
  internal_table: boolean,
  table_comment: string,
  has_primary_key: boolean,
  table_columns: Array<NestedColumnInfoInternal>
};



// Note: Using ScalarTypeKey here instead of ScalarType to show that we have only used
//       the capability documented types, and that ScalarTypeKey is a subset of ScalarType
function determineScalarType(datatype: DataType): ScalarTypeKey {
  switch (datatype.type_category) {
    case "BOOLEAN": return "bool";
    case "NUMERIC": return "number";
    case "DATETIME": return "DateTime";
    case "STRING": return "string";
    default:
      console.warn(`Errors may occur due to non-standard type category: ${datatype.type_category} for type ${datatype.type_ddl}`);
  }
  switch(datatype.logical_type) {
    case "LIST": return "string"; //TODO: Implement list handling
    case "MAP": return "string"; // TODO: Implement map handling
    case "STRUCT": return "string"; //TODO: Imelement struct handling
    default:
      console.error(`Unknown logical type encountered: ${datatype.logical_type}.`);
      return "string";
  }
}

function getColumns(cols: NestedColumnInfoInternal[], source: TableTypeInternal) : ColumnInfo[] {
  return cols.map(column => {
    //const isAutoIncrement = column.definition.some((def: any) => def.type === "constraint" && def.autoIncrement === true);
    const isAutoIncrement = false; // TODO: determine if value is from sequence
    const isGenerated = column.is_generated;
    const isViewColumn = source == "VIEW";

    const isVirtual = isViewColumn || isAutoIncrement || isGenerated;

    return {
      name: column.column_name,
      type: determineScalarType(column.data_type),
      nullable: column.is_nullable === null,
      insertable: MUTATIONS,
      updatable: MUTATIONS,
      ...(isVirtual ? 
          { value_generated: { 
              type: isAutoIncrement ? "auto_increment" : "default_value"} } 
          : {})
    };
  })
}

function nullableCast(ds: any[]): boolean {
  for(var d of ds) {
    if(d.type === 'constraint' && d.variant == 'not null') {
      return false;
    }
  }
  return true;
}

const formatTableInfo = (config: Config, detailLevel: DetailLevel): ((info: TableInfoInternal) => TableInfo) => {
  switch (detailLevel) {
    case "everything": return formatEverythingTableInfo(config);
    case "basic_info": return formatBasicTableInfo(config);
    default: return unreachable(detailLevel);
  }
}

const formatBasicTableInfo = (config: Config) => (info: TableInfoInternal): TableInfo => {
  const name = config.explicit_main_schema ? ["main", info.table_name] : [info.table_name];
  return {
    name: name,
    type: "table"
  }
}

const formatEverythingTableInfo = (config: Config) => (info: TableInfoInternal): TableInfo => {
  const basicTableInfo = formatBasicTableInfo(config)(info);
  // TODO: Setup keys and such
  //const ast = sqliteParser(info.sql);
  //const columnsDdl = getColumnsDdl(ast);
  //const primaryKeys = getPrimaryKeyNames(ast);
  //const foreignKeys = ddlFKs(config, basicTableInfo.name, ast);
  //const primaryKey = primaryKeys.length > 0 ? { primary_key: primaryKeys } : {};
  //const foreignKey = foreignKeys.length > 0 ? { foreign_keys: Object.fromEntries(foreignKeys) } : {};

  return {
    ...basicTableInfo,
    //...primaryKey,
    //...foreignKey,
    description: `${info.table_comment}`,
    columns: getColumns(info.table_columns, info.table_type),
    insertable: MUTATIONS,
    updatable: MUTATIONS,
    deletable: MUTATIONS
  }
}

/**
 * @param table
 * @returns true if the table is an SQLite meta table such as a sequence, index, etc.
 */
function isMeta(table : TableInfoInternal) {
  return table.internal_table || table.schema_name == "information_schema";
}

const includeTable = (config: Config, only_tables?: TableName[]) => (table: TableInfoInternal): boolean => {
  if (isMeta(table) && !config.meta) {
    return false;
  }

  const filterForOnlyTheseTables = only_tables
    // If we're using an explicit main schema, only use those table names that belong to that schema
    ?.filter(n => config.explicit_main_schema ? n.length === 2 && n[0] === "main" : true)
    // Just keep the actual table name
    ?.map(n => n[n.length - 1])

  if (config.tables || only_tables) {
    return (config.tables ?? []).concat(filterForOnlyTheseTables ?? []).indexOf(table.table_name) >= 0;
  } else {
    return true;
  }
}

/**
 * Pulls columns from the output of sqlite-parser.
 * Note that this doesn't check if duplicates are present and will emit them as many times as they are present.
 * This is done as an easy way to preserve order.
 *
 * @param ddl - The output of sqlite-parser
 * @returns - List of columns as present in the output of sqlite-parser.
 */
function getColumnsDdl(ddl: any): any[] {
  if(ddl.type != 'statement' || ddl.variant != 'list') {
    throw new Error("Encountered a non-statement or non-list when parsing DDL for table.");
  }
  return ddl.statement.flatMap((t: any) => {
    if(t.type !=  'statement' || t.variant != 'create' || t.format != 'table') {
      return [];
    }
    return t.definition.flatMap((c: any) => {
      if(c.type != 'definition' || c.variant != 'column') {
        return [];
      }
      return [c];
    });
  })
}

/**
 * Example:
 *
 * foreign_keys: {
 *   "ArtistId->Artist.ArtistId": {
 *     column_mapping: {
 *       "ArtistId": "ArtistId"
 *     },
 *     foreign_table: "Artist",
 *   }
 * }
 *
 * NOTE: We currently don't log if the structure of the DDL is unexpected, which could be the case for composite FKs, etc.
 * NOTE: There could be multiple paths between tables.
 * NOTE: Composite keys are not currently supported.
 *
 * @param ddl
 * @returns [name, FK constraint definition][]
 */
function ddlFKs(config: Config, tableName: Array<string>, ddl: any): [string, Constraint][]  {
  if(ddl.type != 'statement' || ddl.variant != 'list') {
    throw new Error("Encountered a non-statement or non-list DDL for table.");
  }
  return ddl.statement.flatMap((t: any) => {
    if(t.type !=  'statement' || t.variant != 'create' || t.format != 'table') {
      return [];
    }
    return t.definition.flatMap((c: any) => {
      if(c.type != 'definition' || c.variant != 'constraint'
          || c.definition.length != 1 || c.definition[0].type != 'constraint' || c.definition[0].variant != 'foreign key') {
        return [];
      }
      if(c.columns.length != 1) {
        return [];
      }

      const definition = c.definition[0];
      const sourceColumn = c.columns[0];

      if(sourceColumn.type != 'identifier' || sourceColumn.variant != 'column') {
        return [];
      }

      if(definition.references == null || definition.references.columns == null || definition.references.columns.length != 1) {
        return [];
      }

      const destinationColumn = definition.references.columns[0];
      const foreignTable = config.explicit_main_schema ? ["main", definition.references.name] : [definition.references.name];
      return [[
        `${tableName.join('.')}.${sourceColumn.name}->${definition.references.name}.${destinationColumn.name}`,
        { foreign_table: foreignTable,
          column_mapping: {
            [sourceColumn.name]: destinationColumn.name
          }
        }
      ]];
    });
  })
}

function getPrimaryKeyNames(ddl: any): string[] {
  if(ddl.type != 'statement' || ddl.variant != 'list') {
    throw new Error("Encountered a non-statement or non-list DDL for table.");
  }

  return ddl.statement
    .filter((ddlStatement: any) => ddlStatement.type === 'statement' && ddlStatement.variant === 'create' && ddlStatement.format === 'table')
    .flatMap((createTableDef: any) => {
      // Try to discover PKs defined on the column
      // (eg 'Id INTEGER PRIMARY KEY NOT NULL')
      const pkColumns =
        createTableDef.definition
          .filter((def: any) => def.type === 'definition' && def.variant === 'column')
          .flatMap((columnDef: any) =>
            columnDef.definition.some((def: any) => def.type === 'constraint' && def.variant === 'primary key')
              ? [columnDef.name]
              : []
          );
      if (pkColumns.length > 0)
        return pkColumns;

      // Try to discover explicit PK constraint defined inside create table DDL
      // (eg 'CONSTRAINT [PK_Test] PRIMARY KEY ([Id])')
      const pkConstraintColumns =
        createTableDef.definition
          .filter((def: any) => def.type === 'definition' && def.variant === 'constraint' && def.definition.length === 1 && def.definition[0].type === 'constraint' && def.definition[0].variant === 'primary key')
          .flatMap((pkConstraintDef: any) =>
            pkConstraintDef.columns.flatMap((def: any) =>
              def.type === 'identifier' && def.variant === 'column'
                ? [def.name]
                : []
            )
          );

      return pkConstraintColumns;
    })
}

export async function getSchema(config: Config, sqlLogger: SqlLogger, schemaRequest: SchemaRequest = {}): Promise<SchemaResponse> {
  return await withConnection(config, defaultMode, sqlLogger, async db => {
    const detailLevel = schemaRequest.detail_level ?? "everything";

    const results = await db.query(DUCKDB_SCHEMA_QUERY);
    const resultsT: TableInfoInternal[] = results as TableInfoInternal[];
    const filtered: TableInfoInternal[] = resultsT.filter(includeTable(config, schemaRequest?.filters?.only_tables));
    const result:   TableInfo[]         = filtered.map(formatTableInfo(config, detailLevel));

    return {
      tables: result
    };
  });
};
