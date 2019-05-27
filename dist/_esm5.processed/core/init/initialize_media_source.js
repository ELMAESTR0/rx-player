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
import objectAssign from "object-assign";
import { asapScheduler, combineLatest as observableCombineLatest, concat as observableConcat, EMPTY, merge as observableMerge, of as observableOf, ReplaySubject, Subject, timer as observableTimer, } from "rxjs";
import { filter, ignoreElements, map, mergeMap, observeOn, share, startWith, switchMap, take, takeUntil, tap, withLatestFrom, } from "rxjs/operators";
import config from "../../config";
import log from "../../log";
import throttle from "../../utils/rx-throttle";
import ABRManager from "../abr";
import { createManifestPipeline, SegmentPipelinesManager, } from "../pipelines";
import createEMEManager from "./create_eme_manager";
import openMediaSource from "./create_media_source";
import EVENTS from "./events_generators";
import getInitialTime from "./get_initial_time";
import getMediaError from "./get_media_error";
import isEMEReadyEvent from "./is_eme_ready";
import createMediaSourceLoader from "./load_on_media_source";
var DEFAULT_MAX_MANIFEST_REQUEST_RETRY = config.DEFAULT_MAX_MANIFEST_REQUEST_RETRY, DEFAULT_MAX_PIPELINES_RETRY_ON_ERROR = config.DEFAULT_MAX_PIPELINES_RETRY_ON_ERROR;
/**
 * Returns pipeline options based on the global config and the user config.
 * @param {Object} networkConfig
 * @returns {Object}
 */
function getManifestPipelineOptions(_a) {
    var manifestRetry = _a.manifestRetry, offlineRetry = _a.offlineRetry;
    return {
        maxRetry: manifestRetry != null ? manifestRetry :
            DEFAULT_MAX_MANIFEST_REQUEST_RETRY,
        maxRetryOffline: offlineRetry != null ? offlineRetry :
            DEFAULT_MAX_PIPELINES_RETRY_ON_ERROR,
    };
}
/**
 * Central part of the player.
 *
 * Play a content described by the given Manifest.
 *
 * On subscription:
 *  - Creates the MediaSource and attached sourceBuffers instances.
 *  - download the content's manifest
 *  - Perform EME management if needed
 *  - get Buffers for each active adaptations.
 *  - give choice of the adaptation to the caller (e.g. to choose a language)
 *  - returns Observable emitting notifications about the content lifecycle.
 * @param {Object} args
 * @returns {Observable}
 */
export default function InitializeOnMediaSource(_a) {
    var adaptiveOptions = _a.adaptiveOptions, autoPlay = _a.autoPlay, bufferOptions = _a.bufferOptions, clock$ = _a.clock$, keySystems = _a.keySystems, mediaElement = _a.mediaElement, networkConfig = _a.networkConfig, speed$ = _a.speed$, startAt = _a.startAt, textTrackOptions = _a.textTrackOptions, pipelines = _a.pipelines, url = _a.url, handlePlaybackError = _a.handlePlaybackError;
    var warning$ = new Subject();
    // Fetch and parse the manifest from the URL given.
    // Throttled to avoid doing multiple simultaneous requests.
    var fetchManifest = throttle(createManifestPipeline(pipelines, getManifestPipelineOptions(networkConfig), warning$));
    // Subject through which network metrics will be sent by the segment
    // pipelines to the ABR manager.
    var network$ = new Subject();
    // Subject through which each request progression will be sent by the
    // segment pipelines to the ABR manager.
    var requestsInfos$ = new Subject();
    // Creates pipelines for downloading segments.
    var segmentPipelinesManager = new SegmentPipelinesManager(pipelines, requestsInfos$, network$, warning$);
    // Create ABR Manager, which will choose the right "Representation" for a
    // given "Adaptation".
    var abrManager = new ABRManager(requestsInfos$, network$, adaptiveOptions);
    // Create and open a new MediaSource object on the given media element.
    var openMediaSource$ = openMediaSource(mediaElement).pipe(observeOn(asapScheduler), // to launch subscriptions only when all
    share()); // Observables here are linked
    // Create EME Manager, an observable which will manage every EME-related
    // issue.
    var emeManager$ = openMediaSource$.pipe(mergeMap(function () { return createEMEManager(mediaElement, keySystems); }), observeOn(asapScheduler), // to launch subscriptions only when all
    share()); // Observables here are linked
    // Translate errors coming from the media element into RxPlayer errors
    // through an Observable.
    var mediaError$ = getMediaError(mediaElement);
    // Emit each time the manifest is refreshed.
    var manifestRefreshed$ = new ReplaySubject(1);
    var loadContent$ = observableCombineLatest([
        openMediaSource$,
        fetchManifest({ url: url, hasClockSynchronization: false }),
        emeManager$.pipe(filter(isEMEReadyEvent), take(1)),
    ]).pipe(mergeMap(function (_a) {
        var mediaSource = _a[0], _b = _a[1], manifest = _b.manifest, sendingTime = _b.sendingTime;
        /**
         * Refresh the manifest on subscription.
         * @returns {Observable}
         */
        function refreshManifest() {
            var refreshURL = manifest.getUrl();
            if (!refreshURL) {
                log.warn("Init: Cannot refresh the manifest: no url");
                return EMPTY;
            }
            var hasClockSynchronization = manifest.hasClockSynchronization();
            return fetchManifest({ url: refreshURL, hasClockSynchronization: hasClockSynchronization }).pipe(tap(function (_a) {
                var newManifest = _a.manifest, newSendingTime = _a.sendingTime;
                manifest.update(newManifest);
                manifestRefreshed$.next({ manifest: manifest, sendingTime: newSendingTime });
            }), ignoreElements(), share() // share the previous side-effect
            );
        }
        var loadOnMediaSource = createMediaSourceLoader({
            mediaElement: mediaElement,
            manifest: manifest,
            clock$: clock$,
            speed$: speed$,
            abrManager: abrManager,
            segmentPipelinesManager: segmentPipelinesManager,
            bufferOptions: objectAssign({ textTrackOptions: textTrackOptions,
                offlineRetry: networkConfig.offlineRetry,
                segmentRetry: networkConfig.segmentRetry }, bufferOptions),
        });
        log.debug("Init: Calculating initial time");
        var initialTime = getInitialTime(manifest, startAt);
        log.debug("Init: Initial time calculated:", initialTime);
        var reloadMediaSource$ = new Subject();
        var buffersError$ = new Subject();
        var onEvent = createEventListener(reloadMediaSource$, buffersError$, refreshManifest);
        var handleReloads$ = reloadMediaSource$.pipe(switchMap(function (reloadInstruction) {
            var reloadAt = (function () {
                if (reloadInstruction) {
                    return reloadInstruction.reloadAt;
                }
                return mediaElement.currentTime;
            })();
            var reloadAutoPlay = (function () {
                if (reloadInstruction) {
                    return reloadInstruction.autoPlay;
                }
                return !mediaElement.paused;
            })();
            return openMediaSource(mediaElement).pipe(mergeMap(function (newMS) { return loadOnMediaSource(newMS, reloadAt, reloadAutoPlay); }), mergeMap(onEvent), startWith(EVENTS.reloadingMediaSource()));
        }));
        var loadOnMediaSource$ = observableConcat(observableOf(EVENTS.manifestReady(abrManager, manifest)), loadOnMediaSource(mediaSource, initialTime, autoPlay).pipe(takeUntil(reloadMediaSource$), mergeMap(onEvent)));
        // Emit when the manifest should be refreshed due to its lifetime being expired
        var manifestAutoRefresh$ = manifestRefreshed$.pipe(startWith({ manifest: manifest, sendingTime: sendingTime }), switchMap(function (_a) {
            var newManifest = _a.manifest, newSendingTime = _a.sendingTime;
            if (newManifest.lifetime) {
                var timeSinceRequest = newSendingTime == null ?
                    0 :
                    performance.now() - newSendingTime;
                var updateTimeout = newManifest.lifetime * 1000 - timeSinceRequest;
                return observableTimer(updateTimeout);
            }
            return EMPTY;
        })).pipe(mergeMap(refreshManifest));
        /**
         * Catches errors from media element and media buffers.
         * If a 'handlePlaybackError' callback is defined, use it to determine
         * whether the player should throw or reload content.
         */
        var mediaErrorsHandler$ = observableMerge(mediaError$, buffersError$).pipe(withLatestFrom(clock$), mergeMap(function (_a) {
            var err = _a[0], clock = _a[1];
            if (handlePlaybackError) {
                var handledDecodeError = handlePlaybackError(clock);
                if (handledDecodeError && handledDecodeError.type === "reload") {
                    reloadMediaSource$.next(handledDecodeError.value);
                    return EMPTY;
                }
            }
            throw err;
        }));
        return observableMerge(loadOnMediaSource$, handleReloads$, manifestAutoRefresh$, mediaErrorsHandler$);
    }));
    return observableMerge(loadContent$, emeManager$, warning$.pipe(map(EVENTS.warning)));
}
/**
 * Generate function reacting to playback events.
 * @param {Subject} reloadMediaSource$
 * @param {Function} refreshManifest
 * @returns {Function}
 */
function createEventListener(reloadMediaSource$, buffersError$, refreshManifest) {
    /**
     * React to playback events.
     * @param {Object} evt
     * @returns {Observable}
     */
    return function onEvent(evt) {
        switch (evt.type) {
            case "buffer-error-event":
                buffersError$.next(evt.value);
                break;
            case "needs-media-source-reload":
                reloadMediaSource$.next(null);
                break;
            case "needs-manifest-refresh":
                return refreshManifest();
        }
        return observableOf(evt);
    };
}