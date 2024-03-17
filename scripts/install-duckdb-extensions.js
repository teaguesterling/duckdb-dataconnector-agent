#!/usr/bin/env node
const duckdb = require('duckdb');
const db = new duckdb.Database(":memory:");

const install_ext = function (ext, then) {
  console.log(`Installing ${ext}`); 
  db.all(`INSTALL ${ext}`, function (error, result) {
    if(error) {
      console.error(`Failed to install ${ext}: ${error}`);
    } else {
      console.log(`Successfully installed: ${ext}`);
      then ? then(ext) : null;
    }
  });
};

const load_ext = function (ext, then) {
  console.log(`Loading ${ext}`); 
  db.all(`LOAD ${ext}`, function (error, result) {
    if(error) {
      console.error(`Failed to load ${ext}: ${error}`);
    } else {
      console.log(`Successfully loaded: ${ext}`);
      then ? then(ext) : null;
    }
  });
};


process.argv.slice(2).forEach(function (arg) {
  install_ext(arg, load_ext);    
});
