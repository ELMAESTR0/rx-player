/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import log from "../utils/log";
import { normalizeBaseURL } from "../utils/url";
import { isCodecSupported } from "./compat";
import { MediaError } from "../errors";
import { normalize as normalizeLang } from "../utils/languages";
import { resolveURL } from "../utils/url";

/**
 * Representation keys directly inherited from the adaptation.
 * If any of those keys are in an adaptation but not in one of its
 * representation, it will be inherited.
 */
const representationBaseType = [
  "audioSamplingRate",
  "codecs",
  "codingDependency",
  "frameRate",
  "height",
  "index",
  "maxPlayoutRate",
  "maximumSAPPeriod",
  "mimeType",
  "profiles",
  "segmentProfiles",
  "width",
];

let uniqueId = 0;
const SUPPORTED_ADAPTATIONS_TYPE = ["audio", "video", "text", "image"];
const DEFAULT_PRESENTATION_DELAY = 15; // TODO might lower that limit.

function _parseBaseURL(manifest) {
  let baseURL = normalizeBaseURL(manifest.locations[0]);
  const period = manifest.periods[0];
  if (period && period.baseURL) {
    baseURL += "" + period.baseURL;
  }
  return baseURL;
}

/**
 * @param {string} location - the manifest's url
 * @param {Object} manifest - the parsed manifest
 * @param {Array.<Object>|Object} subtitles - Will be added to the manifest,
 * as an adaptation.
 * @param {Array.<Object>|Object} images - Will be added to the manifest,
 * as an adaptation.
 * @returns {Object}
 */
function normalizeManifest(location, manifest, subtitles, images) {
  if (!manifest.transportType) {
    throw new MediaError("MANIFEST_PARSE_ERROR", null, true);
  }

  manifest.id = manifest.id || uniqueId++;
  manifest.type = manifest.type || "static";

  const locations = manifest.locations;
  if (!locations || !locations.length) {
    manifest.locations = [location];
  }

  manifest.isLive = manifest.type == "dynamic";

  const rootURL = _parseBaseURL(manifest);

  // TODO(pierre): support multi-locations/cdns
  const urlBase = {
    rootURL,
    baseURL: manifest.baseURL, // TODO so manifest.baseURL is more important
                               // than manifest.periods[0].baseURL?
    isLive: manifest.isLive,
  };

  if (subtitles) {
    subtitles = _normalizeTextAdaptation(subtitles);
  }

  if (images) {
    images = _normalizeImageAdaptation(images);
  }

  const periods = manifest.periods.map((period) =>
    _normalizePeriod(period, urlBase, subtitles, images));

  // TODO(pierre): support multiple periods
  manifest = _mergeAndCloneAttributes(manifest, periods[0]);
  manifest.periods = null;

  if (!manifest.duration) {
    manifest.duration = Infinity;
  }

  if (manifest.isLive) {
    manifest.suggestedPresentationDelay = manifest.suggestedPresentationDelay || DEFAULT_PRESENTATION_DELAY;
    manifest.availabilityStartTime = manifest.availabilityStartTime || 0;
  }

  return manifest;
}

function _normalizePeriod(period, inherit, subtitles, images) {
  period.id = period.id || uniqueId++;

  let adaptations = period.adaptations;
  adaptations = adaptations.concat(subtitles || []);
  adaptations = adaptations.concat(images || []);
  adaptations = adaptations.map((ada) => _normalizeAdaptation(ada, inherit));
  adaptations = adaptations.filter((adaptation) => {
    if (SUPPORTED_ADAPTATIONS_TYPE.indexOf(adaptation.type) < 0) {
      log.info("not supported adaptation type", adaptation.type);
      return false;
    } else {
      return true;
    }
  });

  if (adaptations.length === 0) {
    throw new MediaError("MANIFEST_PARSE_ERROR", null, true);
  }

  const adaptationsByType = {};
  for (let i = 0; i < adaptations.length; i++) {
    const adaptation = adaptations[i];
    const adaptationType = adaptation.type;
    const adaptationReps = adaptation.representations;
    adaptationsByType[adaptationType] = adaptationsByType[adaptationType] || [];

    // only keep adaptations that have at least one representation
    if (adaptationReps.length > 0) {
      adaptationsByType[adaptationType].push(adaptation);
    }
  }

  for (const adaptationType in adaptationsByType) {
    if (adaptationsByType[adaptationType].length === 0) {
      throw new MediaError("MANIFEST_INCOMPATIBLE_CODECS_ERROR", null, true);
    }
  }

  period.adaptations = adaptationsByType;
  return period;
}

// TODO perform some cleanup like adaptations.index (indexes are
// in the representations)
function _normalizeAdaptation(initialAdaptation, inherit) {
  if (typeof initialAdaptation.id == "undefined") {
    throw new MediaError("MANIFEST_PARSE_ERROR", null, true);
  }

  const adaptation = _mergeAndCloneAttributes(inherit, initialAdaptation);

  const inheritedFromAdaptation = {};
  representationBaseType.forEach((baseType) => {
    if (baseType in adaptation) {
      inheritedFromAdaptation[baseType] = adaptation[baseType];
    }
  });

  let representations = adaptation.representations.map(
    (rep) => _normalizeRepresentation(
      rep,
      inheritedFromAdaptation,
      adaptation.rootURL,
      adaptation.baseURL,
    )
  )
    .sort((a, b) => a.bitrate - b.bitrate);

  const { type, accessibility = [] } = adaptation;
  if (!type) {
    throw new MediaError("MANIFEST_PARSE_ERROR", null, true);
  }

  if (type == "video" || type == "audio") {
    representations = representations
      .filter((rep) => isCodecSupported(getCodec(rep)));

    if (type === "audio") {
      const isAudioDescription = accessibility.includes("visuallyImpaired");
      adaptation.audioDescription = isAudioDescription;
    }
  }
  else if (type === "text") {
    const isHardOfHearing = accessibility.includes("hardOfHearing");
    adaptation.closedCaption = isHardOfHearing;
  }

  adaptation.representations = representations;
  adaptation.bitrates = representations.map((rep) => rep.bitrate);
  return adaptation;
}

function _normalizeRepresentation(initialRepresentation, inherit, rootURL, baseURL) {
  if (typeof initialRepresentation.id == "undefined") {
    throw new MediaError("MANIFEST_PARSE_ERROR", null, true);
  }

  const representation = _mergeAndCloneAttributes(inherit, initialRepresentation);

  representation.index = representation.index || {};
  if (!representation.index.timescale) {
    representation.index.timescale = 1;
  }

  if (!representation.bitrate) {
    representation.bitrate = 1;
  }

  // Fix issue in some packagers, like GPAC, generating a non
  // compliant mimetype with RFC 6381. Other closed-source packagers
  // may be impacted.
  if (representation.codecs == "mp4a.40.02") {
    representation.codecs = "mp4a.40.2";
  }

  representation.baseURL = resolveURL(rootURL, baseURL, representation.baseURL);
  return representation;
}

/**
 * Normalize subtitles Object/Array to include it in a normalized manifest.
 * @param {Array.<Object>|Object} subtitles
 * @returns {Array.<Object>}
 */
function _normalizeTextAdaptation(subtitles) {
  if (!Array.isArray(subtitles)) {
    subtitles = [subtitles];
  }

  return subtitles.reduce((allSubs, {
    mimeType,
    url,
    language,
    languages,
    closedCaption,
  }) => {
    if (language) {
      languages = [language];
    }

    return allSubs.concat(languages.map((language) => ({
      id: uniqueId++,
      type: "text",
      language: language,
      closedCaption: !!closedCaption,
      baseURL: url,
      representations: [{
        id: uniqueId++,
        mimeType,
        index: {
          indexType: "template",
          duration: Number.MAX_VALUE, // XXX why not Infinity?
          timescale: 1,
          startNumber: 0,
        },
      }],
    })));
  }, []);
}

/**
 * Normalize images Object/Array to include it in a normalized manifest.
 * @param {Array.<Object>|Object} images
 * @returns {Array.<Object>}
 */
function _normalizeImageAdaptation(images) {
  if (!Array.isArray(images)) {
    images = [images];
  }

  return images.map(({ mimeType, url /*, size */ }) => {
    return {
      id: uniqueId++,
      type: "image",
      baseURL: url,
      representations: [{
        id: uniqueId++,
        mimeType,
        index: {
          indexType: "template",
          duration: Number.MAX_VALUE, // XXX why not Infinity?
          timescale: 1,
          startNumber: 0,
        },
      }],
    };
  });
}

/**
 * Merge dist Object in source Object.
 * _Deep merge_ Object attributes (excepted when they are Arrays or Date
 * instances in which cases it is a simple merge).
 * Think of it as a deeper Object.assign (with only two arguments).
 *
 * /!\ the source is mutated during this process
 * @param {Object} source
 * @param {Object} dist
 * @returns {Object}
 */
// TODO remove on manifest switch
function _deepAssignAttributes(source, dist) {
  for (const attr in source) {
    if (!dist.hasOwnProperty(attr)) {
      continue;
    }

    const src = source[attr];
    const dst = dist[attr];

    if (typeof src == "string" ||
        typeof src == "number" ||
       (typeof src == "object" && src instanceof Date)) {
      source[attr] = dst;
    }
    else if (Array.isArray(src)) {
      src.length = 0;
      Array.prototype.push.apply(src, dst);
    }
    else {
      source[attr] = _deepAssignAttributes(src, dst);
    }
  }

  return source;
}

/**
 * Returns an object which is a merge of all arguments given
 * (Object.assign-like) but with all the corresponding merged attributes
 * cloned (they do not share the same references than the original attributes).
 *
 * This is useful to keep representations, for example, sharing inherited
 * Objects to also share their references. In that case, an update of a single
 * representation would update every other one.
 *
 * @param {...Object} args
 * @returns {Object}
 */
function _mergeAndCloneAttributes(...args) {
  const res = {};

  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    for (const attr in arg) {
      if (res.hasOwnProperty(attr)) {
        continue;
      }

      const val = arg[attr];
      if (val && typeof val === "object") {
        if (val instanceof Date) {
          res[attr] = new Date(val.getTime());
        }
        else if (Array.isArray(val)) {
          res[attr] = val.slice(0);
        }
        else {
          res[attr] = _mergeAndCloneAttributes(val);
        }
      } else {
        res[attr] = val;
      }
    }
  }

  return res;
}

/**
 * Merge index objects from every newManifest representations into the
 * oldManifest representations.
 *
 * /!\ mutate oldManifest
 * @param {Object} oldManifest
 * @param {Object} newManifest
 * @returns {Object}
 */
// TODO remove on manifest switch
function mergeManifestsIndex(oldManifest, newManifest) {
  const oldAdaptations = oldManifest.adaptations;
  const newAdaptations = newManifest.adaptations;
  for (const type in oldAdaptations) {
    const oldAdas = oldAdaptations[type];
    const newAdas = newAdaptations[type];
    oldAdas.forEach((a, i) => {
      a.representations.forEach((r, j) => {
        _deepAssignAttributes(r.index, newAdas[i].representations[j].index);
      });
    });
  }
  return oldManifest;
}

// TODO uncomment on manifest switch
// TODO Check and re-check the id thing
// function updateManifest(oldManifest, newManifest) {
//   const oldAdaptations = oldManifest.getAdaptations();
//   oldAdaptations.forEach(oA => {
//     const newAdaptation = oA.id != null && newManifest.getAdaptation(oA.id);
//     if (!newAdaptation) {
//       console.warn(`manifest: adaptation "${oA.id}" not found when merging.`);
//       return;
//     }
//     oA.representations.forEach(oR => {
//       const newRepr = oR.id != null && newManifest.getRepresentation(oR.id);
//       if (!newRepr) {
//         console.warn(
//           `manifest: representation "${oR.id}" not found when merging.`
//         );
//         return;
//       }
//       oR.index.update(newRepr.index);
//     });
//   });
//   return oldManifest;
// }

/**
 * Add time to a manifest live gap.
 * @param {Object} manifest
 * @param {Number} addedTime
 */
// TODO remove on manifest switch
function updateLiveGap(manifest, addedTime) {
  if (manifest.isLive) {
    manifest.presentationLiveGap += addedTime;
  }
}

/**
 * Construct the codec string from given codecs and mimetype.
 * @param {Object} representation
 * @returns {string}
 */
function getCodec(representation) {
  const { codecs, mimeType } = representation;

  // TODO uncomment on manifest switch
  // const { codec, mimeType } = representation;
  return `${mimeType};codecs="${codecs}"`;
}

/**
 * Get every adaptations parsed in an array of objects with 3 properties:
 *   - type {string}: e.g. audio/video
 *   - adaptation {Object}: the adaptation itself
 *   - codec {string}: the codec string for this adaptation
 * @param {Object} manifest
 * @returns {Array.<Object>}
 */
// TODO remove on manifest switch
function getAdaptations(manifest) {
  const adaptationsByType = manifest.adaptations;
  if (!adaptationsByType) {
    return [];
  }

  const adaptationsList = [];
  for (const type in adaptationsByType) {
    const adaptations = adaptationsByType[type];
    adaptationsList.push({
      type: type,
      adaptations: adaptations,
      codec: getCodec(adaptations[0].representations[0]),
    });
  }

  return adaptationsList;
}

/**
 * Returns only adaptations for a given type (audio/video/image...).
 * @param {Object} manifest
 * @param {string} type
 * @returns {Array.<Object>}
 */
// TODO still needed? on manifest switch
function getAdaptationsByType(manifest, type) {
  const { adaptations } = manifest;
  const adaptationsForType = adaptations && adaptations[type];
  if (adaptationsForType) {
    return adaptationsForType;
  } else {
    return [];
  }
}

// TODO remove on manifest switch
function getAvailableAudioTracks(manifest) {
  return getAdaptationsByType(manifest, "audio")
    .map((adaptation) => ({
      language: normalizeLang(adaptation.language),
      audioDescription: adaptation.audioDescription,
      id: adaptation.id,
    }));
}

// TODO remove on manifest switch
function getAvailableTextTracks(manifest) {
  return getAdaptationsByType(manifest, "text")
    .map((adaptation) => ({
      language: normalizeLang(adaptation.language),
      closedCaption: adaptation.closedCaption,
      id: adaptation.id,
    }));
}

// TODO uncomment on manifest switch
// function getAudioTracks(manifest) {
//   const audioAdaptations = manifest.adaptations.audio;
//   if (!audioAdaptations) {
//     return [];
//   }
//   return audioAdaptations
//     .map((adaptation) => ({
//       language: normalizeLang(adaptation.language),
//       audioDescription: adaptation.isAudioDescription,
//       id: adaptation.id,
//     }));
// }

// TODO uncomment on manifest switch
// function getTextTracks(manifest) {
//   const textAdaptations = manifest.adaptations.text;
//   if (!textAdaptations) {
//     return [];
//   }
//   return textAdaptations
//     .map((adaptation) => ({
//       language: normalizeLang(adaptation.language),
//       closedCaption: adaptation.isClosedCaption,
//       id: adaptation.id,
//     }));
// }

export {
  normalizeManifest,
  mergeManifestsIndex,
  updateLiveGap,
  getCodec,
  getAdaptations,
  getAdaptationsByType,
  getAvailableTextTracks,
  getAvailableAudioTracks,

  // TODO uncomment on manifest switch
  // updateManifest,
  // getAudioTracks,
  // getTextTracks,
};
