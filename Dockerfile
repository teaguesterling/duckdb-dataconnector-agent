FROM node:21

## If you choose to use the apline version of node, you'll need to do this
## Note that out-of-tree extensions will not work due to musl-glibc issues
# UNCOMMENT FOR ALPINE
#RUN apk add libc6-compat glibc-bin libstdc++ gcompat
# This will be added to the /app dir with `npm link`
#RUN apk add git make cmake gcc g++ python3
#RUN git clone https://github.com/duckdb/duckdb-node /opt/duckdb-node
#WORKDIR /opt/duckdb-node
#RUN git checkout v0.10.0
#RUN make complete_build
#RUN make test || echo "Potential failures... be careful"
#RUN apk del git make cmake gcc g++ python3
# END UNCOMMENT FOR ALPINE

WORKDIR /app
COPY package.json .
COPY package-lock.json .

# If CI fails (which it will), use install instead
RUN npm ci || npm install

# This is the "hack" to use our locally built version
# UNCOMMENT FOR ALPINE
#RUN npm uninstall duckdb
#RUN npm link /opt/duckdb-node
# END UNCOMMENT FOR ALPINE

# COMMENT OUT FOR APLINE
COPY scripts scripts
RUN node scripts/install-duckdb-extensions.js \
    parquet json icu \
    httpfs aws azure \
    excel spatial \
    sqlite_scanner postgres_scanner
# END COMMENT OUT FOR ALPINE

COPY tsconfig.json .
COPY src src

# This is just to ensure everything compiles ahead of time.
# We'll actually run using ts-node to ensure we get TypesScript
# stack traces if something fails at runtime.
RUN npm run typecheck

EXPOSE 8100

# We don't bother doing typechecking when we run (only TS->JS transpiling)
# because we checked it above already. This uses less memory at runtime.
CMD [ "npm", "run", "--silent", "start-no-typecheck" ]
