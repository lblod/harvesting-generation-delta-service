import { sparqlEscapeUri } from "mu";
import { appendFile } from "fs/promises";
import { createReadStream } from "fs";
import * as sjp from "sparqljson-parse";
import { querySudo as query } from "@lblod/mu-auth-sudo";
import readline from "readline";
import { Readable } from "stream";
import {
  BUFFER_SIZE,
  HIGH_LOAD_DATABASE_ENDPOINT,
  DEFAULT_GRAPH,
} from "../constants";
import * as stream from "stream";
import * as N3 from "n3";
import { createGunzip } from "zlib";
const connectionOptions = {
  sparqlEndpoint: HIGH_LOAD_DATABASE_ENDPOINT,
  mayRetry: true,
};
export async function getFilePath(remoteFileUri) {
  const result = await query(
    `
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>

    SELECT ?file
    WHERE {
      GRAPH <${DEFAULT_GRAPH}> {
        ?file nie:dataSource ${sparqlEscapeUri(remoteFileUri)} .
      }
    } LIMIT 1`,
    {},
    connectionOptions,
  );
  if (result.results.bindings.length) {
    const file = result.results.bindings[0]["file"].value;
    console.log(`Getting contents of file ${file}`);
    const path = file.replace("share://", "/share/");
    return path;
  }
}

export async function appendJsonFile(content, path) {
  try {
    await appendFile(path, content, "utf-8");
  } catch (e) {
    console.log(`Failed to append JSON to file <${path}>.`);
    throw e;
  }
}

export async function getFileByNameAndApplyByBatch(
  fileName,
  task,
  callback = async () => { },
) {
  const PREFIXES = `
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    PREFIX owl: <http://www.w3.org/2002/07/owl#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX task: <http://redpencil.data.gift/vocabularies/tasks/>
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX oslc: <http://open-services.net/ns/core#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX adms: <http://www.w3.org/ns/adms#>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX cogs: <http://vocab.deri.ie/cogs#>
    PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
    PREFIX dbpedia: <http://dbpedia.org/ontology/>
    PREFIX jobstat: <http://redpencil.data.gift/id/concept/JobStatus/>
    PREFIX tasko: <http://lblod.data.gift/id/jobs/concept/TaskOperation/>`;

  const defaultLimitSize = 1000;

  const countFn = async () => {
    const result = await query(`
        ${PREFIXES}
        SELECT (count(distinct ?path) as ?count)  WHERE {
          GRAPH <${DEFAULT_GRAPH}> {
            ${sparqlEscapeUri(task.task)}
              a task:Task ;
              dct:isPartOf ?job.
            ?job ^dct:isPartOf ?tasks.
             ?tasks task:inputContainer ?inputContainer .

            ?inputContainer
              a nfo:DataContainer ;
              task:hasFile ?logicalFile .

            ?logicalFile prov:wasDerivedFrom ?derivedFrom.
            ?logicalFile
              a nfo:FileDataObject ;
              nfo:fileName ?fileName .

            ?path
              a nfo:FileDataObject ;
              nie:dataSource ?logicalFile .
            filter (?fileName in ("${fileName}", "${fileName}.gz"))
          }
        }`);
    if (result.results.bindings.length) {
      return result.results.bindings[0].count.value;
    } else {
      return 0;
    }
  };

  const queryFn = async (limitSize, offset) => {
    const queryInputContainer = `
    ${PREFIXES}
    SELECT  ?path ?derivedFrom  WHERE {
      SELECT DISTINCT ?path ?derivedFrom  WHERE {
        GRAPH <${DEFAULT_GRAPH}> {
          ${sparqlEscapeUri(task.task)}
            a task:Task ;
            dct:isPartOf ?job.
          ?job ^dct:isPartOf ?tasks.
           ?tasks task:inputContainer ?inputContainer .

          ?inputContainer
            a nfo:DataContainer ;
            task:hasFile ?logicalFile .

          ?logicalFile prov:wasDerivedFrom ?derivedFrom.
          ?logicalFile
            a nfo:FileDataObject ;
            nfo:fileName ?fileName .

          ?path
            a nfo:FileDataObject ;
            nie:dataSource ?logicalFile .
          filter (?fileName in ("${fileName}", "${fileName}.gz"))
        }
      } order by ?path
    } limit ${limitSize} offset ${offset}
  `;
    await fetchFileInputContainerAndApplyBatch(queryInputContainer, callback);
  };
  const count = await countFn(task);
  const pagesCount =
    count > defaultLimitSize ? Math.ceil(count / defaultLimitSize) : 1;

  for (let page = 0; page <= pagesCount; page++) {
    await queryFn(defaultLimitSize, page * defaultLimitSize);
  }
}
export async function fetchFileInputContainerAndApplyBatch(
  queryInputContainer,
  callback,
) {
  const fileResponse = await query(queryInputContainer, {}, connectionOptions);
  const parser = new sjp.SparqlJsonParser();
  const files = parser.parseJsonResults(fileResponse);
  let buf = [];
  const sizeBuf = BUFFER_SIZE;
  for (const f of files) {
    const path = f.path.value.replace("share://", "/share/");
    let fileStream = createReadStream(path);
    if (path.endsWith("gz")) {
      fileStream = fileStream.pipe(createGunzip());
    }
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      buf.push(line); // assuming N-TRIPLES notation
      if (buf.length == sizeBuf) {
        const arrayStream = new ArrayReadableStream(buf);
        const store = await streamToN3Store(arrayStream);
        await callback(store, f.derivedFrom);
        buf = [];
      }
    }
    if (buf.length) {
      const arrayStream = new ArrayReadableStream(buf);
      const store = await streamToN3Store(arrayStream);
      await callback(store, f.derivedFrom);
      buf = [];
    }
  }
}
export async function getTriplesInFileAndApplyByBatch(
  fileName,
  task,
  callback = async () => { },
) {
  await getFileByNameAndApplyByBatch(fileName, task, callback);
}
class ArrayReadableStream extends Readable {
  constructor(array, options = {}) {
    super(options);
    this.array = array;
    this.index = 0;
  }

  _read() {
    if (this.index >= this.array.length) {
      this.push(null);
      return;
    }

    const chunk = this.array[this.index];
    this.push(chunk);
    this.index++;
  }
}

function streamToN3Store(arrayStream) {
  const store = new N3.Store();
  const consumer = new stream.Writable({
    write(quad, _encoding, done) {
      store.addQuad(quad);
      done();
    },
    objectMode: true,
  });
  const streamParser = new N3.StreamParser();
  arrayStream.pipe(streamParser);
  streamParser.pipe(consumer);
  return new Promise((resolve, reject) => {
    consumer.on("close", () => {
      resolve(store);
    });
    consumer.on("error", reject);
  });
}
