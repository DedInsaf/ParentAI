"""Voice setup is now in the app. This command also installs XTTS interactively."""
import argparse

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--install-model', action='store_true')
    args = parser.parse_args()
    if args.install_model:
        from TTS.api import TTS
        TTS('tts_models/multilingual/multi-dataset/xtts_v2').to('cpu')
        print('XTTS готова. Запустите python run_app.py')
    else:
        from run_app import main
        main()
