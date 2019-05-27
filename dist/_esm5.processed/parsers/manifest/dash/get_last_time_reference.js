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
/**
 * Returns "last time of reference" from the adaptation given, considering a
 * live content.
 * Undefined if a time could not be found.
 *
 * We consider the earliest last time from every representations in the given
 * adaptation.
 * @param {Object} adaptation
 * @returns {Number|undefined}
 */
function getLastTimeReferenceFromAdaptation(adaptation) {
    // Here's how we do, for each possibility:
    //
    //  1. every representations have an index:
    //    - returns minimum for every representations
    //
    //  2. no index for 1+ representation(s):
    //    - returns undefined
    //
    //  3. Invalid index found somewhere:
    //    - returns undefined
    if (!adaptation) {
        return undefined;
    }
    var representations = adaptation.representations || [];
    var lastTimeReferences = representations
        .map(function (representation) {
        var lastPosition = representation.index.getLastPosition();
        return lastPosition != null ? lastPosition : undefined;
    });
    if (lastTimeReferences.some(function (x) { return x == null; })) {
        return undefined;
    }
    var representationsMin = Math.min.apply(Math, lastTimeReferences);
    return isNaN(representationsMin) ? undefined : representationsMin;
}
/**
 * Get presentation live gap from manifest informations.
 * @param {Object} manifest
 * @returns {number}
 */
export default function getLastTimeReference(manifest) {
    if (manifest.periods.length === 0) {
        throw new Error("DASH Parser: no period available for a live content");
    }
    var lastPeriodAdaptations = manifest.periods[manifest.periods.length - 1].adaptations;
    var firstAdaptationsFromLastPeriod = lastPeriodAdaptations.video || lastPeriodAdaptations.audio;
    if (!firstAdaptationsFromLastPeriod || !firstAdaptationsFromLastPeriod.length) {
        throw new Error("DASH Parser: Can't find first adaptation from last period");
    }
    var firstAdaptationFromLastPeriod = firstAdaptationsFromLastPeriod[0];
    return firstAdaptationsFromLastPeriod == null ?
        undefined : getLastTimeReferenceFromAdaptation(firstAdaptationFromLastPeriod);
}