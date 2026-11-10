export interface MeteredCall {
  sql: string;
  rowsRead: number;
}

interface MeteredStatement {
  sql: string;
  inner: D1PreparedStatement;
}

// Records every D1 round trip and its rows_read, which is what D1 bills. Lets
// a test run the real query helpers rather than a copy of their SQL, so that
// rewriting a query can't quietly bring a scan back. first() hides meta, so
// it runs through all() instead. A batch is one round trip, recorded under
// the SQL of its statements.
export function meteredDb(db: D1Database): { db: D1Database; calls: MeteredCall[] } {
  const calls: MeteredCall[] = [];

  function wrap(sql: string, inner: D1PreparedStatement): MeteredStatement & Record<string, unknown> {
    const all = async () => {
      const result = await inner.all();
      calls.push({ sql, rowsRead: result.meta.rows_read });
      return result;
    };
    return {
      sql,
      inner,
      bind: (...values: unknown[]) => wrap(sql, inner.bind(...values)),
      all,
      first: async () => (await all()).results[0] ?? null,
      run: async () => {
        const result = await inner.run();
        calls.push({ sql, rowsRead: result.meta.rows_read });
        return result;
      },
    };
  }

  const metered = {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: async (statements: MeteredStatement[]) => {
      const results = await db.batch(statements.map((s) => s.inner));
      const rowsRead = results.reduce((sum, r) => sum + r.meta.rows_read, 0);
      calls.push({ sql: [...new Set(statements.map((s) => s.sql))].join("; "), rowsRead });
      return results;
    },
  };
  return { db: metered as unknown as D1Database, calls };
}
