/* Polygon Crest GUI extension glue for the Emscripten build (ysflight-web).
 *
 * Upstream builds the editor as geblgui (library) + a per-platform main that
 * provides exactly three PolyCre* factory functions; the EMSCRIPTEN gate skips
 * that main, so this translation unit supplies them instead.  Shape follows
 * upstream/public/src/ysgebl/src/main/ysgebl_gui_extension.cpp:
 *
 *   Copyright (c) 2017 Soji Yamakawa (CaptainYS, http://www.ysflight.com)
 *   BSD 2-clause — see the upstream file for the full license text.
 *
 * Web-port additions Copyright (c) 2026 ysflight-web contributors, same license.
 */

#include <ysgebl_gui_editor_base.h>
#include <ysgebl_gui_extension_base.h>

class GeblGuiExtensionWeb : public GeblGuiExtensionBase
{
public:
	GeblGuiExtensionWeb(class GeblGuiEditorBase &canvas) : GeblGuiExtensionBase(canvas)
	{
	}
	virtual ~GeblGuiExtensionWeb()
	{
	}
	class FsGui3DViewControlDialogBase *CreateCustomViewControlDialog(class FsGui3DViewControl &) override
	{
		return NULL; // the default view-control dialog is adequate
	}
	void CreateModelessDialog(void) override
	{
	}
	void DeleteModelessDialog(void) override
	{
	}
	void AddMenu(class GeblGuiEditorMainMenu *) override
	{
		// No extension menu in the web port (yet).
	}
	void OnClearUIMode(void) override
	{
	}
	void FinalSetUp(void) override
	{
	}
};

GeblGuiExtensionBase *PolyCreCreateGuiExtension(class GeblGuiEditorBase &canvas)
{
	return new GeblGuiExtensionWeb(canvas);
}

void PolyCreDeleteGuiExtension(GeblGuiExtensionBase *ptr)
{
	delete ptr;
}

int PolyCreGetCustomFontHeight(void)
{
	return 0; // default size
}
