import type Scene from "../scene/Scene";
import type { ValueOf } from "../utility-types";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
} from "../element/types";
import { ShapeCache } from "../scene/ShapeCache";
import { isTextElement } from "../element";
import { getFontString } from "../utils";
import { FONT_FAMILY } from "../constants";
import {
  LOCAL_FONT_PROTOCOL,
  FONT_METADATA,
  GOOGLE_FONTS_RANGES,
  type FontMetadata,
} from "./metadata";
import { ExcalidrawFont, type ExcalidrawFontFace, type Font } from "./ExcalidrawFont";
import { getContainerElement } from "../element/textElement";

import Virgil from "./assets/Virgil-Regular.woff2";
import Excalifont from "./assets/Excalifont-Regular.woff2";
import Cascadia from "./assets/CascadiaCode-Regular.woff2";
import ComicShanns from "./assets/ComicShanns-Regular.woff2";
import Liberation from "./assets/LiberationSans-Regular.woff2";

import { NunitoFontFaces } from "./woff2/Nunito";
import { LilitaFontFaces } from "./woff2/Lilita";
import { VirgilFontFaces } from "./woff2/Virgil";
import { XiaolaiFontFaces } from "./woff2/Xiaolai";
import { ExcalifontFontFaces } from "./woff2/Excalifont";

export class Fonts {
  // it's ok to track fonts across multiple instances only once, so let's use
  // a static member to reduce memory footprint
  public static readonly loadedFontsCache = new Set<string>();

  private static _registered:
    | Map<
        number,
        {
          metadata: FontMetadata;
          fonts: Font[];
        }
      >
    | undefined;

  private static _initialized: boolean = false;

  public static get registered() {
    // lazy load the font registration
    if (!Fonts._registered) {
      Fonts._registered = Fonts.init();
    } else if (!Fonts._initialized) {
      // case when host app register fonts before they are lazy loaded
      // don't override whatever has been previously registered
      Fonts._registered = new Map([
        ...Fonts.init().entries(),
        ...Fonts._registered.entries(),
      ]);
    }

    return Fonts._registered;
  }

  public get registered() {
    return Fonts.registered;
  }

  private readonly scene: Scene;

  constructor({ scene }: { scene: Scene }) {
    this.scene = scene;
  }

  /**
   * if we load a (new) font, it's likely that text elements using it have
   * already been rendered using a fallback font. Thus, we want invalidate
   * their shapes and rerender. See #637.
   *
   * Invalidates text elements and rerenders scene, provided that at least one
   * of the supplied fontFaces has not already been processed.
   */
  public onLoaded = (fontFaces: readonly FontFace[]) => {
    if (
      // bail if all fonts with have been processed. We're checking just a
      // subset of the font properties (though it should be enough), so it
      // can technically bail on a false positive.
      fontFaces.every((fontFace) => {
        const sig = `${fontFace.family}-${fontFace.style}-${fontFace.weight}-${fontFace.unicodeRange}`;
        if (Fonts.loadedFontsCache.has(sig)) {
          return true;
        }
        Fonts.loadedFontsCache.add(sig);
        return false;
      })
    ) {
      return false;
    }

    let didUpdate = false;

    const elementsMap = this.scene.getNonDeletedElementsMap();

    for (const element of this.scene.getNonDeletedElements()) {
      if (isTextElement(element)) {
        didUpdate = true;
        ShapeCache.delete(element);
        const container = getContainerElement(element, elementsMap);
        if (container) {
          ShapeCache.delete(container);
        }
      }
    }

    if (didUpdate) {
      this.scene.triggerUpdate();
    }
  };

  /**
   * Load font faces for a given scene and trigger scene update.
   */
  public loadSceneFonts = async (): Promise<FontFace[]> => {
    const sceneFamilies = this.getSceneFontFamilies();
    const loaded = await Fonts.loadFontFaces(sceneFamilies);
    this.onLoaded(loaded);
    return loaded;
  };

  /**
   * Gets all the font families for the given scene.
   */
  public getSceneFontFamilies = () => {
    return Fonts.getFontFamilies(this.scene.getNonDeletedElements());
  };

  /**
   * Load font faces for passed elements - use when the scene is unavailable (i.e. export).
   */
  public static loadFontsForElements = async (
    elements: readonly ExcalidrawElement[],
  ): Promise<FontFace[]> => {
    const fontFamilies = Fonts.getFontFamilies(elements);
    return await Fonts.loadFontFaces(fontFamilies);
  };

  private static async loadFontFaces(
    fontFamilies: Array<ExcalidrawTextElement["fontFamily"]>,
  ) {
    // add all registered font faces into the `document.fonts` (if not added already)
    for (const { fonts, metadata } of Fonts.registered.values()) {
      // skip registering font faces for local fonts (i.e. Helvetica)
      if (metadata.local) {
        continue;
      }

      for (const { fontFace } of fonts) {
        if (!window.document.fonts.has(fontFace)) {
          window.document.fonts.add(fontFace);
        }
      }
    }

    const loadedFontFaces = await Promise.all(
      fontFamilies.map(async (fontFamily) => {
        const fontString = getFontString({
          fontFamily,
          fontSize: 16,
        });

        // WARN: without "text" param it does not have to mean that all font faces are loaded, instead it could be just one!
        if (!window.document.fonts.check(fontString)) {
          try {
            // WARN: browser prioritizes loading only font faces with unicode ranges for characters which are present in the document (html & canvas), other font faces could stay unloaded
            // we might want to retry here, i.e.  in case CDN is down, but so far I didn't experience any issues - maybe it handles retry-like logic under the hood
            return await window.document.fonts.load(fontString);
          } catch (e) {
            // don't let it all fail if just one font fails to load
            console.error(
              `Failed to load font "${fontString}" from urls "${Fonts.registered
                .get(fontFamily)
                ?.fonts.map((x) => x.urls)}"`,
              e,
            );
          }
        }

        return Promise.resolve();
      }),
    );

    return loadedFontFaces.flat().filter(Boolean) as FontFace[];
  }

  /**
   * WARN: should be called just once on init, even across multiple instances.
   */
  private static init() {
    const fonts = {
      registered: new Map<
        ValueOf<typeof FONT_FAMILY>,
        { metadata: FontMetadata; fonts: Font[] }
      >(),
    };

    const init = (
      family: keyof typeof FONT_FAMILY,
      ...fontFaces: ExcalidrawFontFace[]
    ) => {
      const metadata = FONT_METADATA[FONT_FAMILY[family]];

      register.call(fonts, family, metadata, ...fontFaces);
    };

    // init("Cascadia", FONT_METADATA[FONT_FAMILY.Cascadia], {
    //   uri: Cascadia,
    // });

    // init("Comic Shanns", FONT_METADATA[FONT_FAMILY["Comic Shanns"]], {
    //   uri: ComicShanns,
    // });

     init("Excalifont", ...ExcalifontFontFaces);

    // // keeping for backwards compatibility reasons, uses system font (Helvetica on MacOS, Arial on Win)
    // init("Helvetica", FONT_METADATA[FONT_FAMILY.Helvetica], {
    //   uri: LOCAL_FONT_PROTOCOL,
    // });

    // // used for server-side pdf & png export instead of helvetica (technically does not need metrics, but kept in for consistency)
    // init("Liberation Sans", FONT_METADATA[FONT_FAMILY["Liberation Sans"]], {
    //   uri: Liberation,
    // });

    init("Lilita One", ...LilitaFontFaces);
    init("Nunito", ...NunitoFontFaces);
    // prioritize Virgil (last font face wins)
    init("Virgil", ...VirgilFontFaces);
    // TODO_CHINESE: trafeoffs here are
    // + font faces are defined just once (not per each family) and they could could be shared between multiple family (though browsers might be smart enough to share the same font resource between multiple fontface definitions)
    // + measureText API might struggle if everything is defined within the same font face (assumption, no proof)
    // - server-side built process needs to be manually adjusted (to skip creating ttf for this and instead merge it with existing families)
    // - subsetting needs to account for each fallback
    init ("Xiaolai", ...XiaolaiFontFaces);

    Fonts._initialized = true;

    return fonts.registered;
  }

  private static getFontFamilies(
    elements: ReadonlyArray<ExcalidrawElement>,
  ): Array<ExcalidrawTextElement["fontFamily"]> {
    return Array.from(
      elements.reduce((families, element) => {
        if (isTextElement(element)) {
          families.add(element.fontFamily);
        }
        return families;
      }, new Set<number>()),
    );
  }
}

/**
 * Register a new font.
 *
 * @param family font family
 * @param metadata font metadata
 * @param faces font faces
 */
function register(
  this:
    | Fonts
    | {
        registered: Map<
          ValueOf<typeof FONT_FAMILY>,
          { metadata: FontMetadata; fonts: Font[] }
        >;
      },
  family: string,
  metadata: FontMetadata,
  ...faces: ExcalidrawFontFace[]
) {
  // TODO: likely we will need to abandon number "id" in order to support custom fonts
  const familyId = FONT_FAMILY[family as keyof typeof FONT_FAMILY];
  const registeredFamily = this.registered.get(familyId);

  if (!registeredFamily) {
    this.registered.set(familyId, {
      metadata,
      fonts: faces.map(
        ({ uri, descriptors }) => new ExcalidrawFont(family, uri, descriptors),
      ),
    });
  }

  return this.registered;
}

/**
 * Calculates vertical offset for a text with alphabetic baseline.
 */
export const getVerticalOffset = (
  fontFamily: ExcalidrawTextElement["fontFamily"],
  fontSize: ExcalidrawTextElement["fontSize"],
  lineHeightPx: number,
) => {
  const { unitsPerEm, ascender, descender } =
    Fonts.registered.get(fontFamily)?.metadata.metrics ||
    FONT_METADATA[FONT_FAMILY.Virgil].metrics;

  const fontSizeEm = fontSize / unitsPerEm;
  const lineGap =
    (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;

  const verticalOffset = fontSizeEm * ascender + lineGap;
  return verticalOffset;
};

/**
 * Gets line height forr a selected family.
 */
export const getLineHeight = (fontFamily: FontFamilyValues) => {
  const { lineHeight } =
    Fonts.registered.get(fontFamily)?.metadata.metrics ||
    FONT_METADATA[FONT_FAMILY.Excalifont].metrics;

  return lineHeight as ExcalidrawTextElement["lineHeight"];
};
