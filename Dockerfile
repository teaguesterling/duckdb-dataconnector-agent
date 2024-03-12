FROM node:16-alpine

RUN apk add libc6-compat libstdc++
RUN ln -s libc.musl-x86_64.so.1 /lib/ld-linux-x86-64.so.2

# For yet-to-be-determined reasons, the duckdb package from NPM segfaults
# We'll install the build dependencies here, pull the most recent version
# perform a complete build (a regular build fails due to npm dependencies),
# run the test suite (which will have a few failures), and then remove the 
# build dependencies.
#
# This will be added to the /app dir with `npm link`
RUN apk add git make cmake gcc g++ python3
RUN git clone https://github.com/duckdb/duckdb-node /opt/duckdb-node
WORKDIR /opt/duckdb-node
RUN git checkout v0.10.0
RUN make complete_build
RUN make test || echo "Potential failures... be careful"
RUN apk del git make cmake gcc g++ python3

WORKDIR /app
COPY package.json .
COPY package-lock.json .
RUN npm link /opt/duckdb-node
RUN cat package.json
RUN sed -i '/"duckdb":/d' package.json

# If CI fails (which it will), use install instead
RUN npm ci || npm install

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
