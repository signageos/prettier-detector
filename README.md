# Prettier Detector

Reverse detecting of current code style to create initial .prettierrc config file.

## Usage
```sh
npx @signageos/prettier-detector src/**/*.ts -o parser=typescript > .prettierrc
```

## Algorithm
The tool try to go through the all files of your code and create the prettier config file based on the lowest changes it would do to your code.

After successful detection of config file, it shows all changes which will be done to your code when you apply prettier the standard way.
