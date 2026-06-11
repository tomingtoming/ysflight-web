/* ////////////////////////////////////////////////////////////

File Name: fsairsound_emscripten.cpp

Sound implementation for the Emscripten (WebAssembly) port of YSFLIGHT,
written for the ysflight-web project.

The game-side logic mirrors sounddll/linux-alsa/fsairsounddll.cpp (which on
desktop platforms is loaded as a plug-in), but plays audio through OpenAL,
which Emscripten maps to Web Audio.  Voice (ATC chatter) is not implemented.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as YSFLIGHT itself.

//////////////////////////////////////////////////////////// */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include <AL/al.h>
#include <AL/alc.h>

#include <ysclass.h>
#include <fs.h>

#include "fsairsoundenum.h"
#include "fsvoiceenum.h"
#include "yswavfile.h"

// ----------------------------------------------------------------------------
// OpenAL player

#define FS_NUM_ONESHOT_SOURCE 8

class FsOpenALPlayer
{
private:
	ALCdevice *device;
	ALCcontext *context;
	ALuint oneShotSource[FS_NUM_ONESHOT_SOURCE];
	int nextOneShot;
	ALuint environSource;
	const YsWavFile *currentEnvironWav;
	bool available;

public:
	FsOpenALPlayer();
	bool Initialize(void);
	void Terminate(void);
	ALuint GetBuffer(YsWavFile *wavFile);
	void PlayOneShot(YsWavFile *wavFile);
	void PlayEnviron(YsWavFile *wavFile);
	void StopEnviron(void);
	void StopAll(void);
};

FsOpenALPlayer::FsOpenALPlayer()
{
	device=nullptr;
	context=nullptr;
	nextOneShot=0;
	environSource=0;
	currentEnvironWav=nullptr;
	available=false;
}

bool FsOpenALPlayer::Initialize(void)
{
	device=alcOpenDevice(nullptr);
	if(nullptr==device)
	{
		printf("OpenAL: no audio device.\n");
		return false;
	}
	context=alcCreateContext(device,nullptr);
	if(nullptr==context)
	{
		alcCloseDevice(device);
		device=nullptr;
		return false;
	}
	alcMakeContextCurrent(context);

	alGenSources(FS_NUM_ONESHOT_SOURCE,oneShotSource);
	alGenSources(1,&environSource);
	alSourcei(environSource,AL_LOOPING,AL_TRUE);

	// Headroom so that the looping engine sound plus simultaneous one-shots
	// don't clip when summed by Web Audio.
	alListenerf(AL_GAIN,0.6f);

	available=true;
	return true;
}

void FsOpenALPlayer::Terminate(void)
{
	if(true!=available)
	{
		return;
	}
	StopAll();
	alDeleteSources(FS_NUM_ONESHOT_SOURCE,oneShotSource);
	alDeleteSources(1,&environSource);
	alcMakeContextCurrent(nullptr);
	alcDestroyContext(context);
	alcCloseDevice(device);
	context=nullptr;
	device=nullptr;
	available=false;
}

/*! Lazily creates an AL buffer for a wav file.  The handle is cached in a
    side table keyed by the wav-file pointer (the wav set is small and static). */
ALuint FsOpenALPlayer::GetBuffer(YsWavFile *wavFile)
{
	static struct {const YsWavFile *wav; ALuint buf;} cache[64];
	static int nCached=0;

	if(nullptr==wavFile || 0==wavFile->SizeInByte())
	{
		return 0;
	}
	for(int i=0; i<nCached; ++i)
	{
		if(cache[i].wav==wavFile)
		{
			return cache[i].buf;
		}
	}
	if(64<=nCached)
	{
		return 0;
	}

	// Do NOT use YsWavFile::ConvertTo16Bit here: it duplicates each unsigned
	// 8-bit sample into both bytes of a 16-bit word, which is severely
	// distorted when interpreted as signed PCM.  OpenAL's 8-bit formats are
	// unsigned, matching the wav data as loaded, so pass 8-bit data through.
	ALenum format;
	const unsigned char *data=wavFile->DataPointer();
	unsigned char *converted=nullptr;
	if(8==wavFile->BitPerSample())
	{
		format=(YSTRUE==wavFile->Stereo()) ? AL_FORMAT_STEREO8 : AL_FORMAT_MONO8;
		if(YSTRUE==wavFile->IsSigned())
		{
			// Rare: signed 8-bit wav.  OpenAL wants unsigned; flip the sign bit.
			converted=new unsigned char [wavFile->SizeInByte()];
			for(unsigned int i=0; i<wavFile->SizeInByte(); ++i)
			{
				converted[i]=data[i]^0x80;
			}
			data=converted;
		}
	}
	else
	{
		format=(YSTRUE==wavFile->Stereo()) ? AL_FORMAT_STEREO16 : AL_FORMAT_MONO16;
	}

	ALuint buf=0;
	alGenBuffers(1,&buf);
	alBufferData(buf,format,data,wavFile->SizeInByte(),wavFile->PlayBackRate());
	if(nullptr!=converted)
	{
		delete [] converted;
	}

	cache[nCached].wav=wavFile;
	cache[nCached].buf=buf;
	++nCached;
	return buf;
}

void FsOpenALPlayer::PlayOneShot(YsWavFile *wavFile)
{
	if(true!=available)
	{
		return;
	}
	const ALuint buf=GetBuffer(wavFile);
	if(0==buf)
	{
		return;
	}
	const ALuint src=oneShotSource[nextOneShot];
	nextOneShot=(nextOneShot+1)%FS_NUM_ONESHOT_SOURCE;
	alSourceStop(src);
	alSourcei(src,AL_BUFFER,buf);
	alSourcePlay(src);
}

void FsOpenALPlayer::PlayEnviron(YsWavFile *wavFile)
{
	if(true!=available)
	{
		return;
	}
	if(currentEnvironWav==wavFile)
	{
		ALint state;
		alGetSourcei(environSource,AL_SOURCE_STATE,&state);
		if(AL_PLAYING==state)
		{
			return;
		}
	}
	const ALuint buf=GetBuffer(wavFile);
	if(0==buf)
	{
		return;
	}
	alSourceStop(environSource);
	alSourcei(environSource,AL_BUFFER,buf);
	alSourcePlay(environSource);
	currentEnvironWav=wavFile;
}

void FsOpenALPlayer::StopEnviron(void)
{
	if(true!=available)
	{
		return;
	}
	if(nullptr!=currentEnvironWav)
	{
		alSourceStop(environSource);
		currentEnvironWav=nullptr;
	}
}

void FsOpenALPlayer::StopAll(void)
{
	if(true!=available)
	{
		return;
	}
	StopEnviron();
	for(int i=0; i<FS_NUM_ONESHOT_SOURCE; ++i)
	{
		alSourceStop(oneShotSource[i]);
	}
}

// ----------------------------------------------------------------------------
// Game-facing state (mirrors fsairsounddll.cpp)

class FsSoundStatus
{
public:
	FSSND_ENGINETYPE engineType=FSSND_ENGINE_SILENT;
	int numEngine=0;
	double enginePower=0.0;
	FSSND_MACHINEGUNTYPE machineGunType=FSSND_MACHINEGUN_SILENT;
	FSSND_ALARMTYPE alarmType=FSSND_ALARM_SILENT;
};

static FsOpenALPlayer *fsAlPlayer=nullptr;
static FsSoundStatus sndStatus;

static YSBOOL fsSoundMasterSwitch=YSTRUE;
static YSBOOL fsSoundEnvironmentalSwitch=YSTRUE;
static YSBOOL fsSoundOneTimeSwitch=YSTRUE;

static YsWavFile jetWav[10],afterBurnerWav,propWav[10];
static YsWavFile machineGunWav[FSSND_NUM_MACHINEGUNTYPE];
static YsWavFile alarmWav[FSSND_NUM_ALARMTYPE];
static YsWavFile oneTimeWav[FSSND_NUM_ONETIMETYPE];

void FsSoundInitialize(void)
{
	if(nullptr!=fsAlPlayer)
	{
		return;
	}
	fsAlPlayer=new FsOpenALPlayer;
	fsAlPlayer->Initialize();

	char fn[64];
	for(int i=0; i<10; ++i)
	{
		sprintf(fn,"sound/engine%d.wav",i);
		jetWav[i].LoadWav(fn);
		sprintf(fn,"sound/prop%d.wav",i);
		propWav[i].LoadWav(fn);
	}
	afterBurnerWav.LoadWav("sound/burner.wav");

	machineGunWav[(int)FSSND_MACHINEGUN_MACHINEGUN].LoadWav("sound/gun.wav");

	alarmWav[(int)FSSND_ALARM_STALL].LoadWav("sound/stallhorn.wav");
	alarmWav[(int)FSSND_ALARM_MISSILE].LoadWav("sound/warning.wav");
	alarmWav[(int)FSSND_ALARM_TERRAIN].LoadWav("sound/gearhorn.wav");

	oneTimeWav[(int)FSSND_ONETIME_DAMAGE].LoadWav("sound/damage.wav");
	oneTimeWav[(int)FSSND_ONETIME_MISSILE].LoadWav("sound/missile.wav");
	oneTimeWav[(int)FSSND_ONETIME_BANG].LoadWav("sound/bang.wav");
	oneTimeWav[(int)FSSND_ONETIME_BLAST].LoadWav("sound/blast.wav");
	oneTimeWav[(int)FSSND_ONETIME_TOUCHDWN].LoadWav("sound/touchdwn.wav");
	oneTimeWav[(int)FSSND_ONETIME_HIT].LoadWav("sound/hit.wav");
	oneTimeWav[(int)FSSND_ONETIME_BLAST2].LoadWav("sound/blast2.wav");
	oneTimeWav[(int)FSSND_ONETIME_GEARUP].LoadWav("sound/retractldg.wav");
	oneTimeWav[(int)FSSND_ONETIME_GEARDOWN].LoadWav("sound/extendldg.wav");
	oneTimeWav[(int)FSSND_ONETIME_BOMBSAWAY].LoadWav("sound/bombsaway.wav");
	oneTimeWav[(int)FSSND_ONETIME_ROCKET].LoadWav("sound/rocket.wav");
	oneTimeWav[(int)FSSND_ONETIME_NOTICE].LoadWav("sound/notice.wav");
}

void FsSoundTerminate(void)
{
	if(nullptr!=fsAlPlayer)
	{
		fsAlPlayer->Terminate();
		delete fsAlPlayer;
		fsAlPlayer=nullptr;
	}
}

void FsSoundSetMasterSwitch(YSBOOL sw)
{
	fsSoundMasterSwitch=sw;
	if(YSTRUE!=sw && nullptr!=fsAlPlayer)
	{
		fsAlPlayer->StopAll();
	}
}

void FsSoundSetEnvironmentalSwitch(YSBOOL sw)
{
	fsSoundEnvironmentalSwitch=sw;
	if(YSTRUE!=sw && nullptr!=fsAlPlayer)
	{
		fsAlPlayer->StopEnviron();
	}
}

void FsSoundSetOneTimeSwitch(YSBOOL sw)
{
	fsSoundOneTimeSwitch=sw;
}

void FsSoundStopAll(void)
{
	if(nullptr!=fsAlPlayer)
	{
		fsAlPlayer->StopAll();
	}
}

void FsSoundSetVehicleName(const char [])
{
}

void FsSoundSetEngine(FSSND_ENGINETYPE engineType,int numEngine,const double power)
{
	sndStatus.engineType=engineType;
	sndStatus.numEngine=numEngine;
	sndStatus.enginePower=power;
}

void FsSoundSetMachineGun(FSSND_MACHINEGUNTYPE machineGunType)
{
	sndStatus.machineGunType=machineGunType;
}

void FsSoundSetAlarm(FSSND_ALARMTYPE alarmType)
{
	sndStatus.alarmType=alarmType;
}

void FsSoundSetOneTime(FSSND_ONETIMETYPE oneTimeType)
{
	if(YSTRUE==fsSoundMasterSwitch &&
	   YSTRUE==fsSoundOneTimeSwitch &&
	   nullptr!=fsAlPlayer &&
	   0<=(int)oneTimeType && (int)oneTimeType<FSSND_NUM_ONETIMETYPE)
	{
		fsAlPlayer->PlayOneShot(&oneTimeWav[(int)oneTimeType]);
	}
}

void FsSoundKeepPlaying(void)
{
	if(nullptr==fsAlPlayer || YSTRUE!=fsSoundMasterSwitch)
	{
		return;
	}
	if(YSTRUE!=fsSoundEnvironmentalSwitch)
	{
		return;
	}

	YsWavFile *wavToPlay=nullptr;
	if(FSSND_MACHINEGUN_SILENT!=sndStatus.machineGunType)
	{
		wavToPlay=&machineGunWav[(int)sndStatus.machineGunType];
	}
	else if(FSSND_ALARM_SILENT!=sndStatus.alarmType)
	{
		wavToPlay=&alarmWav[(int)sndStatus.alarmType];
	}
	else if(FSSND_ENGINE_SILENT!=sndStatus.engineType)
	{
		int level=(int)(sndStatus.enginePower*10.0);
		if(level<0)
		{
			level=0;
		}
		else if(9<level)
		{
			level=9;
		}

		switch(sndStatus.engineType)
		{
		case FSSND_ENGINE_JETNORMAL:
			wavToPlay=&jetWav[level];
			break;
		case FSSND_ENGINE_JETAFTERBURNER:
			wavToPlay=&afterBurnerWav;
			break;
		case FSSND_ENGINE_PROPELLER:
		case FSSND_ENGINE_TURBOPROP:
		case FSSND_ENGINE_HELICOPTER:
			wavToPlay=&propWav[level];
			break;
		default:
			break;
		}
	}

	if(nullptr!=wavToPlay)
	{
		fsAlPlayer->PlayEnviron(wavToPlay);
	}
	else
	{
		fsAlPlayer->StopEnviron();
	}
}

// ----------------------------------------------------------------------------
// Voice (ATC chatter): not implemented in the web port.

void FsVoiceStopAll(void)
{
}

void FsVoiceSpeak(int,const struct FsVoicePhrase [])
{
}

void FsVoiceKeepSpeaking(void)
{
}
