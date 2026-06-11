/* ////////////////////////////////////////////////////////////

File Name: yssystemfont_emscripten.cpp

Emscripten (browser) back-end of yssystemfont for the ysflight-web project.
Text is rasterized with the Canvas 2D API, so every script the browser can
display (including CJK) works without bundling font files.  Structured after
the Android back-end (android/ysandroidsystemfont.cpp), with the browser
taking the place of the Java-side renderer.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as yssystemfont itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>
#include <stdio.h>
#include <string.h>

#include <yssystemfont.h>

// Renders UTF-8 text with the shared offscreen canvas and returns a
// malloc'ed coverage map (one byte per pixel).  dim[0]=width, dim[1]=height.
EM_JS(unsigned char *,YsfwRenderTextCoverage,(const char *utf8,int fontHeight,int *dim),
{
	if(!Module.ysfwFontCanvas)
	{
		Module.ysfwFontCanvas=document.createElement('canvas');
	}
	var canvas=Module.ysfwFontCanvas;
	var ctx=canvas.getContext('2d',{willReadFrequently:true});

	var text=UTF8ToString(utf8);
	var lines=text.split('\n');
	var px=Math.max(6,Math.round(fontHeight*0.8));
	var font=px+'px sans-serif';

	ctx.font=font;
	var w=1;
	for(var i=0; i<lines.length; ++i)
	{
		w=Math.max(w,Math.ceil(ctx.measureText(lines[i]).width));
	}
	var h=Math.max(1,fontHeight*lines.length);

	if(canvas.width<w || canvas.height<h)
	{
		canvas.width=w;
		canvas.height=h;
	}
	ctx.clearRect(0,0,w,h);
	ctx.font=font;  // Canvas resize resets the context state.
	ctx.fillStyle='#ffffff';
	ctx.textBaseline='middle';
	for(var i=0; i<lines.length; ++i)
	{
		ctx.fillText(lines[i],0,fontHeight*i+fontHeight*0.55);
	}

	var img=ctx.getImageData(0,0,w,h).data;
	var ptr=_malloc(w*h);
	for(var p=0; p<w*h; ++p)
	{
		HEAPU8[ptr+p]=img[p*4+3];
	}
	HEAP32[dim>>2]=w;
	HEAP32[(dim>>2)+1]=h;
	return ptr;
});

EM_JS(void,YsfwMeasureText,(const char *utf8,int fontHeight,int *dim),
{
	if(!Module.ysfwFontCanvas)
	{
		Module.ysfwFontCanvas=document.createElement('canvas');
	}
	var ctx=Module.ysfwFontCanvas.getContext('2d',{willReadFrequently:true});

	var text=UTF8ToString(utf8);
	var lines=text.split('\n');
	var px=Math.max(6,Math.round(fontHeight*0.8));
	ctx.font=px+'px sans-serif';

	var w=1;
	for(var i=0; i<lines.length; ++i)
	{
		w=Math.max(w,Math.ceil(ctx.measureText(lines[i]).width));
	}
	HEAP32[dim>>2]=w;
	HEAP32[(dim>>2)+1]=Math.max(1,fontHeight*lines.length);
});

// ----------------------------------------------------------------------------

class YsSystemFontCache::InternalData
{
public:
	int fontHeight;

	InternalData()
	{
		fontHeight=16;
	}

	// wchar_t is UTF-32 under Emscripten.
	static char *MakeUtf8(const wchar_t wStr[])
	{
		int len=0;
		while(0!=wStr[len])
		{
			++len;
		}
		char *utf8=new char [len*4+1];
		int n=0;
		for(int i=0; i<len; ++i)
		{
			const unsigned int c=(unsigned int)wStr[i];
			if(c<0x80)
			{
				utf8[n++]=(char)c;
			}
			else if(c<0x800)
			{
				utf8[n++]=(char)(0xC0|(c>>6));
				utf8[n++]=(char)(0x80|(c&0x3F));
			}
			else if(c<0x10000)
			{
				utf8[n++]=(char)(0xE0|(c>>12));
				utf8[n++]=(char)(0x80|((c>>6)&0x3F));
				utf8[n++]=(char)(0x80|(c&0x3F));
			}
			else
			{
				utf8[n++]=(char)(0xF0|(c>>18));
				utf8[n++]=(char)(0x80|((c>>12)&0x3F));
				utf8[n++]=(char)(0x80|((c>>6)&0x3F));
				utf8[n++]=(char)(0x80|(c&0x3F));
			}
		}
		utf8[n]=0;
		return utf8;
	}

	// Returns a new[] coverage map (one byte per pixel).
	unsigned char *RenderCoverage(int &wid,int &hei,const wchar_t wStr[]) const
	{
		char *utf8=MakeUtf8(wStr);
		int dim[2]={0,0};
		unsigned char *mallocPtr=YsfwRenderTextCoverage(utf8,fontHeight,dim);
		delete [] utf8;

		if(nullptr==mallocPtr)
		{
			return nullptr;
		}
		wid=dim[0];
		hei=dim[1];
		auto cov=new unsigned char [wid*hei];
		memcpy(cov,mallocPtr,wid*hei);
		free(mallocPtr);
		return cov;
	}
};

// ----------------------------------------------------------------------------

YsSystemFontCache::YsSystemFontCache()
{
	internal=new InternalData;
}

YsSystemFontCache::~YsSystemFontCache()
{
	delete internal;
}

YSRESULT YsSystemFontCache::RequestDefaultFont(void)
{
	return YSOK;
}

YSRESULT YsSystemFontCache::RequestDefaultFontWithHeight(int height)
{
	if(0<height)
	{
		internal->fontHeight=height;
	}
	return YSOK;
}

YSRESULT YsSystemFontCache::MakeSingleBitBitmap(YsSystemFontTextBitmap &bmp,const wchar_t wStr[],YSBOOL reverse) const
{
	int w,h;
	auto cov=internal->RenderCoverage(w,h,wStr);
	if(nullptr==cov)
	{
		return YSERR;
	}

	const int bitPerPixel=1;
	const int bytePerLine=(w+7)/8;
	auto bitArray=new unsigned char [bytePerLine*h];
	memset(bitArray,0,bytePerLine*h);
	for(int y=0; y<h; ++y)
	{
		auto covTop=(YSTRUE!=reverse ? cov+y*w : cov+(h-1-y)*w);
		auto bitTop=bitArray+y*bytePerLine;
		for(int x=0; x<w; ++x)
		{
			if(128<=covTop[x])
			{
				bitTop[x/8]|=(0x80>>(x%8));
			}
		}
	}
	delete [] cov;
	bmp.SetBitmap(w,h,bytePerLine,bitPerPixel,bitArray);
	return YSOK;
}

YSRESULT YsSystemFontCache::MakeRGBABitmap(YsSystemFontTextBitmap &bmp,const wchar_t wStr[],const unsigned char fgCol[3],const unsigned char bgCol[3],YSBOOL reverse) const
{
	int w,h;
	auto cov=internal->RenderCoverage(w,h,wStr);
	if(nullptr==cov)
	{
		return YSERR;
	}

	const int bytePerLine=w*4;
	const int bitPerPixel=32;
	auto rgba=new unsigned char [bytePerLine*h];
	for(int y=0; y<h; ++y)
	{
		auto covTop=(YSTRUE!=reverse ? cov+y*w : cov+(h-1-y)*w);
		auto dstTop=rgba+y*bytePerLine;
		for(int x=0; x<w; ++x)
		{
			const unsigned int a=covTop[x];
			dstTop[x*4  ]=(unsigned char)((fgCol[0]*a+bgCol[0]*(255-a))/255);
			dstTop[x*4+1]=(unsigned char)((fgCol[1]*a+bgCol[1]*(255-a))/255);
			dstTop[x*4+2]=(unsigned char)((fgCol[2]*a+bgCol[2]*(255-a))/255);
			dstTop[x*4+3]=(unsigned char)a;
		}
	}
	delete [] cov;
	bmp.SetBitmap(w,h,bytePerLine,bitPerPixel,rgba);
	return YSOK;
}

YSRESULT YsSystemFontCache::MakeGrayScaleAndAlphaBitmap(YsSystemFontTextBitmap &bmp,const wchar_t wStr[],unsigned char fgCol,unsigned char bgCol,YSBOOL reverse) const
{
	int w,h;
	auto cov=internal->RenderCoverage(w,h,wStr);
	if(nullptr==cov)
	{
		return YSERR;
	}

	const int bytePerLine=w*2;
	const int bitPerPixel=16;
	auto ga=new unsigned char [bytePerLine*h];
	for(int y=0; y<h; ++y)
	{
		auto covTop=(YSTRUE!=reverse ? cov+y*w : cov+(h-1-y)*w);
		auto dstTop=ga+y*bytePerLine;
		for(int x=0; x<w; ++x)
		{
			const unsigned int a=covTop[x];
			dstTop[x*2  ]=(unsigned char)((fgCol*a+bgCol*(255-a))/255);
			dstTop[x*2+1]=(unsigned char)a;
		}
	}
	delete [] cov;
	bmp.SetBitmap(w,h,bytePerLine,bitPerPixel,ga);
	return YSOK;
}

YSRESULT YsSystemFontCache::GetTightBitmapSize(int &wid,int &hei,const wchar_t wStr[]) const
{
	char *utf8=InternalData::MakeUtf8(wStr);
	int dim[2]={0,0};
	YsfwMeasureText(utf8,internal->fontHeight,dim);
	delete [] utf8;
	wid=dim[0];
	hei=dim[1];
	return YSOK;
}
